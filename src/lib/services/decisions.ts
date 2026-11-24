import { audienceOfKind } from "@/lib/promotions/registry";
import { commitStrategy } from "./strategy";
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { addDays, todayISO, type ISODate } from "../dates";
import { assertTransition, type ActionState } from "../engine/stateMachine";
import type { Candidate } from "../engine/types";
import { executionBlock, providerOfTarget } from "../integrations/capabilities";
import { flagFor } from "./flags";
import { recordAudit } from "../audit/log";
import { agentActor, userActor, type AuditType } from "../audit/types";
import { preparePriceLabsWrite, readBackPriceLabsWrite, sendPriceLabsWrite, WriteError, rollbackContext, rollbackPriceLabsWrite, manualRestoreText, type PreparedWrite, type SafePlan, type WriteOutcome } from "./pricelabs-write";
import { raiseAlert, resolveAlerts, acknowledgeAlert, getAlert, STUCK_AFTER_MS } from "./execution-alerts";
import { requestHash } from "../integrations/pricelabs-write";
import { can, denyMessage, executePermission, PERMISSION_LABEL, ROLE_LABEL, type Permission, type Role } from "../rbac";

const { opportunities, revenueActions, calendarDays, promotions, properties, integrations, agentRuns } = schema;
/** `role` : droits de la personne (US-084). Sans droit, le service refuse avant tout changement et consigne la tentative. */
type Actor = { id: string; name: string; tenantId: string; role: Role };
/** `db` ou une transaction : approbation, exécution, vérification et retour arrière écrivent leur événement d'audit dans la même transaction que le changement d'état (US-012). */
type Exec = Pick<typeof db, "insert" | "update" | "select">;
/** `kind` : de quel ordre est le refus (l'API en déduit le code HTTP) ; par défaut, l'état courant ne permet pas l'opération. */
export type DecisionErrorKind = "CONFLICT" | "VALIDATION" | "NOT_FOUND" | "FORBIDDEN";
export class DecisionError extends Error { constructor(message: string, readonly kind: DecisionErrorKind = "CONFLICT") { super(message); } }
/** Refus pour droits insuffisants (HTTP 403 côté API). */
export class ForbiddenError extends DecisionError { constructor(message: string) { super(message, "FORBIDDEN"); } }

/**
 * Contrôle de droit (US-084). Un refus est inscrit au journal d'audit (famille « Accès », jamais le contenu de la demande) puis levé :
 * rien n'a changé, mais l'auditeur voit qui a essayé quoi.
 */
async function requirePermission(actor: Actor, permission: Permission, entity: string, entityId: string) {
  if (can(actor.role, permission)) return;
  try {
    await recordAudit(db, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "access.denied", entity, entityId: entityId.slice(0, 64), summary: `${actor.name} (${ROLE_LABEL[actor.role]}) : tentative refusée — ${PERMISSION_LABEL[permission]}.`, payload: { permission, role: actor.role } });
  } catch (e) { console.error("[rbac] refus non consigné", (e as Error).message); }
  throw new ForbiddenError(denyMessage(actor.role, permission));
}

const audit = (ex: Exec, tenantId: string, actor: string, type: AuditType, entity: string, entityId: string, summary: string, payload?: unknown) =>
  recordAudit(ex, { tenantId, actor, type, entity, entityId, summary, payload });
/** Transition d'état d'une action : refusée si l'état a changé entre-temps (deux clics, deux onglets) plutôt qu'écrasée en silence. */
async function move(ex: Exec, actionId: string, tenantId: string, from: ActionState, to: ActionState, patch: Partial<typeof revenueActions.$inferInsert> = {}) {
  assertTransition(from, to);
  const done = await ex.update(revenueActions).set({ ...patch, status: to, updatedAt: new Date() }).where(and(eq(revenueActions.id, actionId), eq(revenueActions.tenantId, tenantId), eq(revenueActions.status, from))).returning({ id: revenueActions.id });
  if (!done.length) throw new DecisionError("Cette action vient de changer d'état : rechargez la page.");
}
/** Borne les textes libres avant qu'ils n'entrent dans un journal qui ne s'efface jamais. */
const clip = (t: string | undefined | null, max = 500) => (t ?? "").trim().slice(0, max);
/** Change l'état d'un dossier seulement s'il est encore dans l'un des états attendus : deux décisions concurrentes ne peuvent pas toutes deux aboutir. */
async function moveOpp(ex: Exec, tenantId: string, id: string, from: string[], patch: Partial<typeof opportunities.$inferInsert>) {
  const done = await ex.update(opportunities).set(patch).where(and(eq(opportunities.id, id), eq(opportunities.tenantId, tenantId), inArray(opportunities.status, from as any))).returning({ id: opportunities.id });
  if (!done.length) throw new DecisionError("Ce dossier vient de changer d'état : rechargez la page.");
}
async function getOpp(tenantId: string, id: string) {
  const [o] = await db.select().from(opportunities).where(and(eq(opportunities.id, id), eq(opportunities.tenantId, tenantId)));
  if (!o) throw new DecisionError("Dossier introuvable.", "NOT_FOUND");
  return o;
}
async function getAction(tenantId: string, id: string) {
  const [a] = await db.select().from(revenueActions).where(and(eq(revenueActions.id, id), eq(revenueActions.tenantId, tenantId)));
  if (!a) throw new DecisionError("Action introuvable.", "NOT_FOUND");
  return a;
}
export function commentRequired(c: Candidate): boolean { return c.audit.verdict === "NEEDS_HUMAN" || c.risk === "HIGH" || c.risk === "CRITICAL"; }

/** Approbation : seule une option non rejetée par l'auditeur peut être approuvée, et jamais par un agent. */
/** Droit de décider, exposé pour les actions de portée large (revue, réinstallation de la démonstration) et les routes d'API. */
export const requireDecide = (actor: Actor, entity = "Tenant", entityId = actor.tenantId) => requirePermission(actor, "decision.decide", entity, entityId);

export async function approve(actor: Actor, opportunityId: string, candidateIndex: number, commentRaw: string): Promise<string | null> {
  await requirePermission(actor, "decision.decide", "Opportunity", opportunityId);
  const comment = clip(commentRaw);
  const o = await getOpp(actor.tenantId, opportunityId);
  if (o.status !== "OPEN") throw new DecisionError("Ce dossier n'est plus ouvert.");
  const c = o.candidates[candidateIndex] as Candidate | undefined;
  if (!c) throw new DecisionError("Option inconnue.", "VALIDATION");
  if (c.audit.verdict === "REJECT") throw new DecisionError("Cette option est rejetée par l'auditeur : elle ne peut pas être approuvée.");
  if (commentRequired(c) && comment.trim().length < 8) throw new DecisionError("Un commentaire est obligatoire pour cette option (risque élevé ou validation demandée par l'auditeur).", "VALIDATION");
  if (c.type === "NO_ACTION") {
    await db.transaction(async (tx) => {
      await moveOpp(tx, actor.tenantId, o.id, ["OPEN"], { status: "DECIDED", decidedAt: new Date(), decision: "NO_ACTION", selected: candidateIndex, deferUntil: c.reviewAt ?? null });
      await audit(tx, actor.tenantId, userActor(actor.id), "opportunity.no_action", "Opportunity", o.id, `${actor.name} retient l'inaction sur ${o.code}${comment ? " — " + comment.trim() : ""}.`, { code: o.code, candidateIndex, comment: comment.trim() || null, reviewAt: c.reviewAt ?? null });
    });
    return null;
  }
  const [p] = await db.select().from(properties).where(eq(properties.id, o.propertyId));
  // US-002 : on n'approuve pas une option que l'on saurait ne pas pouvoir exécuter (coupe-circuit activé depuis la détection, par exemple) ; en observation, l'approbation reste un jugement hypothétique
  if (p?.status !== "SHADOW") {
    const prov = providerOfTarget(c.target.system);
    const [ig] = prov ? await db.select().from(integrations).where(and(eq(integrations.tenantId, actor.tenantId), eq(integrations.provider, prov))) : [];
    const blocked = executionBlock(c.executionMode, { actionType: c.type, provider: prov, isDemo: !!p?.isDemo, killSwitch: !!ig?.killSwitch, flagOff: (await flagFor(actor.tenantId, "write.api", { propertyId: o.propertyId, provider: prov })).reason });
    if (blocked) throw new DecisionError(blocked + " Relancez la revue une fois la cause levée, ou utilisez la procédure manuelle.");
  }
  const id = newId("act");
  await db.transaction(async (tx) => {
    await moveOpp(tx, actor.tenantId, o.id, ["OPEN"], { status: "DECIDED", decidedAt: new Date(), decision: p?.status === "SHADOW" ? "APPROVED_SHADOW" : "APPROVED", selected: candidateIndex });
    await tx.insert(revenueActions).values({
      id, tenantId: actor.tenantId, propertyId: o.propertyId, opportunityId: o.id, type: c.type, label: c.label, target: c.target, parameters: c.parameters,
      simulation: { current: c.current, proposed: c.proposed, expectedDeltaCents: c.expectedDeltaCents, hypothesis: c.hypothesis, executionMode: c.executionMode, measurementWindowDays: c.measurementWindowDays },
      audit: c.audit, status: "DRAFT", riskLevel: c.risk, rollbackPlan: c.rollbackPlan, idempotencyKey: `${o.id}:${candidateIndex}`,
    });
    // la chaîne d'états est rejouée explicitement : aucune mise à jour libre du statut
    await move(tx, id, actor.tenantId, "DRAFT", "SIMULATED");
    await move(tx, id, actor.tenantId, "SIMULATED", "AUDITED");
    await move(tx, id, actor.tenantId, "AUDITED", "PENDING_APPROVAL");
    await move(tx, id, actor.tenantId, "PENDING_APPROVAL", "APPROVED", { approvalComment: comment.trim() || null, approvedById: actor.id, approvedAt: new Date() });
    // pas d'approbation sans sa trace : l'événement est écrit dans la même transaction
    await audit(tx, actor.tenantId, userActor(actor.id), "action.approved", "RevenueAction", id, `${actor.name} approuve « ${c.label} » (${o.code})${comment ? " — " + comment.trim() : ""}.`,
      { code: o.code, opportunityId: o.id, candidateIndex, actionType: c.type, comment: comment.trim() || null, verdict: c.audit.verdict, risk: c.risk, shadow: p?.status === "SHADOW" });
  });
  return id;
}

export async function reject(actor: Actor, opportunityId: string, commentRaw: string) {
  await requirePermission(actor, "decision.decide", "Opportunity", opportunityId);
  const comment = clip(commentRaw);
  const o = await getOpp(actor.tenantId, opportunityId);
  if (o.status !== "OPEN") throw new DecisionError("Ce dossier n'est plus ouvert.");
  await db.transaction(async (tx) => {
    await moveOpp(tx, actor.tenantId, o.id, ["OPEN"], { status: "DECIDED", decidedAt: new Date(), decision: "REJECTED" });
    await audit(tx, actor.tenantId, userActor(actor.id), "opportunity.rejected", "Opportunity", o.id, `${actor.name} rejette la proposition du dossier ${o.code}${comment ? " — " + comment.trim() : ""}.`, { code: o.code, comment: comment.trim() || null });
  });
}
export async function defer(actor: Actor, opportunityId: string, days = 3) {
  await requirePermission(actor, "decision.decide", "Opportunity", opportunityId);
  const o = await getOpp(actor.tenantId, opportunityId);
  if (o.status !== "OPEN") throw new DecisionError("Ce dossier n'est plus ouvert.");
  if (o.veto) throw new DecisionError("Un dossier sous veto ne peut pas être différé.");
  const until = addDays(todayISO(), days);
  await db.transaction(async (tx) => {
    await moveOpp(tx, actor.tenantId, o.id, ["OPEN"], { status: "DEFERRED", deferUntil: until });
    await audit(tx, actor.tenantId, userActor(actor.id), "opportunity.deferred", "Opportunity", o.id, `${actor.name} diffère le dossier ${o.code} jusqu'au ${until.split("-").reverse().join("/")}.`, { code: o.code, until });
  });
}
export async function reopen(actor: Actor, opportunityId: string) {
  await requirePermission(actor, "decision.decide", "Opportunity", opportunityId);
  const o = await getOpp(actor.tenantId, opportunityId);
  if (!["DECIDED", "DEFERRED", "EXPIRED"].includes(o.status)) throw new DecisionError("Ce dossier est déjà ouvert.");
  const acts = await db.select().from(revenueActions).where(eq(revenueActions.opportunityId, o.id));
  if (acts.some((a) => !["CANCELLED", "REJECTED"].includes(a.status))) throw new DecisionError("Une action existe déjà pour ce dossier : utilisez le retour arrière.");
  await db.transaction(async (tx) => {
    await moveOpp(tx, actor.tenantId, o.id, ["DECIDED", "DEFERRED", "EXPIRED"], { status: "OPEN", decision: null, deferUntil: null, decidedAt: null });
    await audit(tx, actor.tenantId, userActor(actor.id), "opportunity.reopened", "Opportunity", o.id, `${actor.name} rouvre le dossier ${o.code}.`, { code: o.code, previousStatus: o.status, previousDecision: o.decision });
  });
}

async function bookedCount(propertyId: string, from: ISODate, to: ISODate) {
  const ds = await db.select().from(calendarDays).where(and(eq(calendarDays.propertyId, propertyId), gte(calendarDays.date, from), lte(calendarDays.date, addDays(to, -1))));
  return { bookedNights: ds.filter((d) => d.state === "BOOKED").length, freeNights: ds.filter((d) => d.state === "FREE").length };
}

/**
 * Exécution. Trois modes : écriture PriceLabs (simulée sur un logement de démonstration),
 * procédure manuelle déclarée avec preuve, ou tâche interne. Jamais d'automatisation d'extranet.
 */
export async function execute(actor: Actor, actionId: string, declaration?: { scope: string; date: string; proof: string }) {
  const a = await getAction(actor.tenantId, actionId);
  await requirePermission(actor, executePermission(a.simulation?.executionMode), "RevenueAction", a.id);
  const o = await getOpp(actor.tenantId, a.opportunityId);
  const [p] = await db.select().from(properties).where(eq(properties.id, a.propertyId));
  if (a.status !== "APPROVED") throw new DecisionError("Seule une action approuvée peut être exécutée.");
  if (p.status === "SHADOW") throw new DecisionError("Logement en période d'observation : l'approbation est enregistrée comme jugement hypothétique, aucune écriture n'est faite.");
  const mode: string = a.simulation.executionMode;
  const provider = providerOfTarget(a.target.system);
  let killSwitch = false;
  if (provider) {
    const [i] = await db.select().from(integrations).where(and(eq(integrations.tenantId, actor.tenantId), eq(integrations.provider, provider)));
    killSwitch = !!i?.killSwitch;
  }
  // US-002 : un write non supporté est impossible. Refus avant tout changement d'état (l'action reste APPROVED), même règle que le bouton de la fiche.
  const blocked = executionBlock(mode, { actionType: a.type, provider, isDemo: p.isDemo, killSwitch, flagOff: (await flagFor(actor.tenantId, "write.api", { propertyId: p.id, provider })).reason });
  if (blocked) throw new DecisionError(blocked);
  const dates: ISODate[] = a.parameters.dates ?? [];
  // les erreurs de saisie sont refusées avant tout changement d'état : une faute de frappe ne fait pas échouer l'action
  if (mode === "MANUAL_RUNBOOK" && (!declaration || declaration.scope.trim().length < 5 || !declaration.date)) throw new DecisionError("Déclarez la portée réellement appliquée et la date d'application.");
  const decl = declaration ? { scope: clip(declaration.scope), date: clip(declaration.date, 10), proof: clip(declaration.proof, 1000) } : undefined;
  const baseline = await bookedCount(a.propertyId, o.stayFrom, o.stayTo);
  // écriture réelle chez PriceLabs (épic 9) : on relit l'état réel et on calcule l'écriture AVANT de quitter « Approuvée » ; un refus ici ne change rien
  const real = mode === "API_PRICELABS" && !p.isDemo;
  let prepared: PreparedWrite | null = null;
  if (real) {
    try { prepared = await preparePriceLabsWrite(p, { id: a.id, tenantId: actor.tenantId, type: a.type, parameters: a.parameters }); }
    catch (e) {
      // précondition non remplie : l'action reste APPROUVÉE, mais le refus est tracé (US-091)
      if (e instanceof WriteError && e.code === "PRECONDITION") await audit(db, actor.tenantId, userActor(actor.id), "action.precondition_failed", "RevenueAction", a.id, `Écriture de « ${a.label} » refusée : ${e.message}`, { code: o.code, actionType: a.type }).catch(() => {}); // la consignation ne masque pas le refus lisible
      if (e instanceof WriteError && e.code === "PRECONDITION") await raiseAlert({ tenantId: actor.tenantId, propertyId: p.id, actionId: a.id, kind: "PRECONDITION_FAILED", dedupeKey: `PRECONDITION:${a.id}`, title: `Écriture de « ${a.label} » refusée : PriceLabs ne correspond plus à ce qui avait été simulé`, detail: `${e.message} L'action reste approuvée, rien n'a été écrit ; relancez la revue si la situation a changé.` });
      throw e instanceof WriteError ? new DecisionError(e.message) : e;
    }
    // même précondition que la simulation, mais AVANT d'écrire : on n'envoie rien à PriceLabs pour échouer ensuite en base
    const local = dates.length ? await db.select().from(calendarDays).where(and(eq(calendarDays.propertyId, p.id), inArray(calendarDays.date, dates))) : [];
    if (local.some((d) => d.state !== "FREE")) throw new DecisionError("Recontrôle : une des nuits a été réservée depuis la simulation. Écriture abandonnée, relancez la revue.");
  }
  await move(db, a.id, actor.tenantId, "APPROVED", "EXECUTING");
  let written: WriteOutcome | null = null;
  try {
    if (real && prepared) {
      // juste avant l'envoi : le coupe-circuit, le drapeau et le mode du logement sont relus (un geste fait pendant la lecture compte)
      written = await sendPriceLabsWrite(prepared, { recheck: async () => {
        const [ig] = provider ? await db.select().from(integrations).where(and(eq(integrations.tenantId, actor.tenantId), eq(integrations.provider, provider))) : [];
        const again = executionBlock(mode, { actionType: a.type, provider, isDemo: p.isDemo, killSwitch: !!ig?.killSwitch, flagOff: (await flagFor(actor.tenantId, "write.api", { propertyId: p.id, provider })).reason });
        if (again) throw new WriteError(again);
      } });
    }
    // écritures, passage à EXECUTED et événement d'audit forment une seule transaction : un échec ne laisse ni demi-écriture ni état sans trace
    await db.transaction(async (tx) => {
      let execution: any;
      if (mode === "API_PRICELABS") {
        // logement réel : la grille locale appartient à PriceLabs (relue à la prochaine synchronisation) ; seule la stratégie est mise à jour ici, et le contrôle « nuit libre » a été fait avant l'envoi
        const before = real || !dates.length ? [] : await tx.select().from(calendarDays).where(and(eq(calendarDays.propertyId, p.id), inArray(calendarDays.date, dates)));
        // précondition : l'état relu doit être celui sur lequel la simulation a été faite
        if (!real && before.some((d) => d.state !== "FREE")) throw new DecisionError("Recontrôle : une des nuits a été réservée depuis la simulation. Écriture abandonnée, relancez la revue.");
        for (const d of before) {
          const patch: Partial<typeof calendarDays.$inferInsert> = {};
          if (a.type === "MIN_STAY_OVERRIDE") patch.minStay = a.parameters.minStay;
          else if (a.type === "RULE_EXCLUSION") { patch.priceCents = a.parameters.nightlyCents; patch.rule = null; }
          else if (a.parameters.restoresFloor) patch.priceCents = a.parameters.nightlyCents;
          else if (typeof a.parameters.changePct === "number" && d.priceCents !== null) patch.priceCents = Math.round(d.priceCents * (1 + a.parameters.changePct / 100) / 100) * 100;
          await tx.update(calendarDays).set(patch).where(and(eq(calendarDays.propertyId, p.id), eq(calendarDays.date, d.date)));
        }
        let prevBase: number | null = p.strategy?.basePriceCents ?? null;
        let prevMin: number | null = p.strategy?.minPriceCents ?? null;
        if (a.type === "BASE_PRICE_CHANGE" && a.parameters.basePriceCents) {
          const r = await commitStrategy(tx, { tenantId: actor.tenantId, propertyId: p.id, next: (s) => ({ ...s, basePriceCents: a.parameters.basePriceCents }), source: "ACTION", createdBy: actor.id });
          if (r) prevBase = r.previous.basePriceCents ?? null;
        }
        if (a.type === "MIN_PRICE_CHANGE" && a.parameters.minPriceCents) {
          const r = await commitStrategy(tx, { tenantId: actor.tenantId, propertyId: p.id, next: (s) => ({ ...s, minPriceCents: a.parameters.minPriceCents }), source: "ACTION", createdBy: actor.id });
          if (r) prevMin = r.previous.minPriceCents ?? null;
        }
        execution = written
          ? { mode: "PRICELABS_API", note: "Écriture PriceLabs confirmée par relecture.", writeId: written.writeId, adapter: written.adapter, beforeHash: written.beforeHash, afterHash: written.afterHash, receipt: { method: written.receipt.method, endpoint: written.receipt.endpoint, status: written.receipt.status, requestHash: written.receipt.requestHash, sentAt: written.receipt.sentAt }, plan: written.plan, remoteBefore: written.before, remoteAfter: written.after, previousOverrides: written.previousOverrides, before: before.map((d) => ({ date: d.date, priceCents: d.priceCents, minStay: d.minStay, rule: d.rule })), previousBasePriceCents: prevBase, previousMinPriceCents: prevMin, baseline }
          : { mode: "DEMO_SIMULATED", note: "Écriture PriceLabs simulée sur le logement de démonstration.", before: before.map((d) => ({ date: d.date, priceCents: d.priceCents, minStay: d.minStay, rule: d.rule })), previousBasePriceCents: prevBase, previousMinPriceCents: prevMin, baseline };
      } else if (mode === "MANUAL_RUNBOOK") {
        if (!decl) throw new DecisionError("Déclarez la portée réellement appliquée et la date d'application.");
        const ch = a.target.channel ?? a.parameters.channel;
        if (a.type === "CHANNEL_PROMO") {
          const pid = newId("promo");
          await tx.insert(promotions).values({ id: pid, tenantId: actor.tenantId, propertyId: p.id, channel: ch, kind: a.parameters.kind, audience: audienceOfKind(a.parameters.kind), createdBy: actor.id, verifiedBy: actor.id, label: a.parameters.label ?? a.label, discountPct: a.parameters.discountPct, stayFrom: a.parameters.stayFrom, stayTo: a.parameters.stayTo, status: "ACTIVE", source: "DECLARED", verifiedAt: new Date() });
          execution = { createdPromotionId: pid };
        } else if (a.type === "PROMO_REMOVAL") {
          await tx.update(promotions).set({ status: "ENDED", endedAt: new Date(), endReason: "Retirée par une action approuvée", updatedAt: new Date() }).where(and(eq(promotions.id, a.parameters.promotionId), eq(promotions.tenantId, actor.tenantId)));
        } else if (a.type === "INVESTIGATION" && ch) {
          await tx.update(promotions).set({ verifiedAt: new Date(), verifiedBy: actor.id, updatedAt: new Date() }).where(and(eq(promotions.propertyId, p.id), eq(promotions.channel, ch), eq(promotions.status, "ACTIVE")));
        }
        execution = { ...execution, mode: "MANUAL_DECLARED", declaredScope: decl!.scope, declaredDate: decl!.date, proof: decl!.proof || null, baseline };
      } else {
        execution = { mode: "INTERNAL", note: decl?.scope || "Tâche interne lancée.", baseline };
      }
      await move(tx, a.id, actor.tenantId, "EXECUTING", "EXECUTED", { execution, executedAt: new Date() });
      if (mode === "API_PRICELABS") await tx.update(schema.executionAlerts).set({ status: "RESOLVED", resolvedAt: new Date(), resolution: "L'action a été écrite avec succès." }).where(and(eq(schema.executionAlerts.tenantId, actor.tenantId), eq(schema.executionAlerts.actionId, a.id), eq(schema.executionAlerts.kind, "PRECONDITION_FAILED"), ne(schema.executionAlerts.status, "RESOLVED")));
      await audit(tx, actor.tenantId, userActor(actor.id), "action.executed", "RevenueAction", a.id, `« ${a.label} » exécutée (${execution.mode === "PRICELABS_API" ? "écriture PriceLabs confirmée par relecture" : execution.mode === "DEMO_SIMULATED" ? "écriture simulée, démonstration" : execution.mode === "MANUAL_DECLARED" ? "procédure manuelle déclarée" : "tâche interne"}).`,
        { code: o.code, actionType: a.type, mode: execution.mode, declaredScope: execution.declaredScope ?? null, declaredDate: execution.declaredDate ?? null, proof: execution.proof ?? null,
          ...(execution.mode === "PRICELABS_API" ? { writeId: execution.writeId, receipt: execution.receipt, adapter: execution.adapter, beforeHash: execution.beforeHash, afterHash: execution.afterHash } : {}) });
    });
  } catch (e) {
    // message technique brut (SQL, URL…) jamais écrit dans le journal : seules nos erreurs métier le sont
    const writeId = written?.writeId ?? (e instanceof WriteError ? e.writeId : null);
    // l'issue est incertaine quand l'écriture est confirmée mais n'a pas pu être finalisée, ou quand le journal n'est pas « refusée » (refus certain de PriceLabs, rien modifié)
    // dans le doute, l'issue est incertaine : « rien n'a été modifié » n'est dit que pour un refus certain (journal « refusée ») ou un refus interne avant tout envoi
    let uncertain = true;
    if (!written) {
      if (e instanceof WriteError && !e.sent && e.code !== "IDEMPOTENT") uncertain = false;
      else if (writeId) { try { const [w] = await db.select({ status: schema.externalWrites.status }).from(schema.externalWrites).where(eq(schema.externalWrites.id, writeId)); uncertain = !(w && w.status === "FAILED"); } catch { /* dans le doute */ } }
    }
    const msg = (e instanceof DecisionError || e instanceof WriteError ? e.message : "erreur technique pendant l'exécution") + (written ? " L'écriture PriceLabs avait déjà été envoyée et confirmée : vérifiez la grille dans PriceLabs et remettez les valeurs d'avant si besoin." : uncertain && e instanceof WriteError && e.sent && !/incertaine|non confirmée|ne la retrouve pas/.test(e.message) ? " L'écriture PriceLabs a pu être envoyée : vérifiez dans PriceLabs." : "");
    try {
      await db.transaction(async (tx) => {
        await move(tx, a.id, actor.tenantId, "EXECUTING", "FAILED", { execution: { error: msg, ...(writeId ? { writeId } : {}) } });
        await audit(tx, actor.tenantId, "system", "action.failed", "RevenueAction", a.id, `Échec d'exécution de « ${a.label} » : ${msg}`, { code: o.code, actionType: a.type });
      });
    } catch { /* l'erreur d'origine prime sur l'échec de sa propre consignation */ }
    // US-094 : alerte immédiate sur un logement réel (jamais pour la démonstration ni une procédure manuelle)
    if (real) {
      await raiseAlert({ tenantId: actor.tenantId, propertyId: p.id, actionId: a.id, writeId, kind: uncertain ? "WRITE_UNCONFIRMED" : "WRITE_FAILED", dedupeKey: `FAILED:${a.id}`,
        title: uncertain ? `Écriture de « ${a.label} » non confirmée : l'état chez PriceLabs est à vérifier` : `Écriture de « ${a.label} » en échec : rien n'a été modifié chez PriceLabs`, detail: msg });
    }
    throw e instanceof WriteError ? new DecisionError(e.message) : e;
  }
}

/** Vérification : relecture de l'état réel. Pour une procédure manuelle, c'est une seconde relecture déclarée. */
export async function verify(actor: Actor, actionId: string) {
  await requirePermission(actor, "action.verify", "RevenueAction", actionId);
  const a = await getAction(actor.tenantId, actionId);
  if (a.status !== "EXECUTED") throw new DecisionError("Seule une action exécutée peut être vérifiée.");
  let check: any = { mode: "DECLARED", note: "Relecture déclarée par le propriétaire dans l'extranet officiel." };
  if (a.execution?.mode === "PRICELABS_API") {
    // relecture réelle chez PriceLabs, comparée à ce qui a été écrit ; une relecture impossible n'est pas une vérification réussie
    const [prop] = await db.select().from(properties).where(and(eq(properties.id, a.propertyId), eq(properties.tenantId, actor.tenantId)));
    let back;
    try { back = await readBackPriceLabsWrite(prop, a.execution.plan as SafePlan); }
    catch (e) { throw new DecisionError(e instanceof WriteError ? e.message : "Relecture PriceLabs impossible : réessayez plus tard."); }
    if (back.mismatches.length) {
      await audit(db, actor.tenantId, agentActor("audit"), "action.verification_failed", "RevenueAction", a.id, `Vérification en échec pour « ${a.label} » : l'état relu chez PriceLabs diffère de l'action approuvée (${back.mismatches.join(" ; ")}).`, { actionType: a.type, mismatches: back.mismatches });
      await raiseAlert({ tenantId: actor.tenantId, propertyId: a.propertyId, actionId: a.id, kind: "DRIFT", supersedes: true, dedupeKey: `DRIFT:${a.id}:${requestHash(back.mismatches).slice(0, 12)}`, title: `« ${a.label} » : PriceLabs ne correspond plus à l'écriture faite`, detail: `${back.mismatches.join(" ; ")}. Lancez un retour arrière si ce n'est pas voulu.` });
      throw new DecisionError(`L'état relu chez PriceLabs diffère de l'action approuvée (${back.mismatches.join(" ; ")}). Aucune correction n'est improvisée : lancez un retour arrière.`);
    }
    await resolveAlerts(actor.tenantId, a.id, "Vérification conforme.", ["DRIFT"]);
    check = { mode: "READ_BACK", note: "Relecture chez PriceLabs conforme à l'écriture enregistrée.", state: back.state };
  } else if (a.execution?.mode === "DEMO_SIMULATED") {
    const dates: ISODate[] = a.parameters.dates ?? [];
    const now = dates.length ? await db.select().from(calendarDays).where(and(eq(calendarDays.propertyId, a.propertyId), inArray(calendarDays.date, dates))) : [];
    const ok = a.type === "MIN_STAY_OVERRIDE" ? now.every((d) => d.minStay === a.parameters.minStay) : a.type === "RULE_EXCLUSION" ? now.every((d) => d.rule === null) : a.type === "MIN_PRICE_CHANGE" ? ((await db.select().from(properties).where(eq(properties.id, a.propertyId)))[0]?.strategy?.minPriceCents === a.parameters.minPriceCents) : true;
    if (!ok) {
      await audit(db, actor.tenantId, agentActor("audit"), "action.verification_failed", "RevenueAction", a.id, `Vérification en échec pour « ${a.label} » : l'état relu diffère de l'action approuvée.`, { actionType: a.type });
      throw new DecisionError("L'état relu diffère de l'action approuvée. Aucune correction n'est improvisée : lancez un retour arrière.");
    }
    check = { mode: "READ_BACK", note: `${now.length} nuit${now.length > 1 ? "s" : ""} relue${now.length > 1 ? "s" : ""} sur ${dates.length} dans la grille de démonstration, sans écart.` };
  }
  const due = addDays(todayISO(), a.simulation.measurementWindowDays || 7);
  await db.transaction(async (tx) => {
    await move(tx, a.id, actor.tenantId, "EXECUTED", "VERIFIED", { verifiedAt: new Date(), execution: { ...a.execution, verification: check } });
    await move(tx, a.id, actor.tenantId, "VERIFIED", "MEASURING", { measureDueAt: due });
    await audit(tx, actor.tenantId, agentActor("audit"), "action.verified", "RevenueAction", a.id, `« ${a.label} » vérifiée ; mesure prévue le ${due.split("-").reverse().join("/")}.`, { actionType: a.type, check: check.mode, measureDueAt: due, requestedBy: userActor(actor.id) });
  });
}

export async function rollback(actor: Actor, actionId: string, reasonRaw: string) {
  const reason = clip(reasonRaw);
  await requirePermission(actor, "action.rollback", "RevenueAction", actionId);
  const a = await getAction(actor.tenantId, actionId);
  if (!["EXECUTED", "VERIFIED", "MEASURING", "FAILED"].includes(a.status)) throw new DecisionError("Cette action ne peut pas être annulée dans son état actuel.");
  // US-090 : tant que le retour arrière par l'API n'existe pas (US-093), annuler une écriture réelle sans la défaire serait un mensonge : refusé
  // US-093 : une écriture partie chez PriceLabs se défait chez PriceLabs, jamais seulement dans l'état local (même sur une action « échouée » dont l'écriture est partie)
  const ctxW = await rollbackContext(actor.tenantId, a.id);
  const touched = a.execution?.mode === "PRICELABS_API" || (!!ctxW.apply && (ctxW.apply.status !== "FAILED" || !!ctxW.apply.receipt || (ctxW.apply.error ?? "").includes("incertaine")));
  let remote: Awaited<ReturnType<typeof rollbackPriceLabsWrite>> | null = null;
  if (touched) {
    const [p] = await db.select().from(properties).where(and(eq(properties.id, a.propertyId), eq(properties.tenantId, actor.tenantId)));
    if (!p) throw new DecisionError("Logement introuvable : retour arrière impossible.");
    const guard = async () => {
      const [ig] = await db.select().from(integrations).where(and(eq(integrations.tenantId, actor.tenantId), eq(integrations.provider, "pricelabs")));
      return executionBlock("API_PRICELABS", { actionType: a.type, provider: "pricelabs", isDemo: p.isDemo, killSwitch: !!ig?.killSwitch, flagOff: (await flagFor(actor.tenantId, "write.api", { propertyId: p.id, provider: "pricelabs" })).reason });
    };
    const manual = ctxW.apply ? ` Valeurs d'avant à remettre à la main dans PriceLabs : ${manualRestoreText(ctxW.apply)}.` : "";
    const first = await guard();
    if (first) {
      await raiseAlert({ tenantId: actor.tenantId, propertyId: a.propertyId, actionId: a.id, kind: "ROLLBACK_FAILED", severity: "WARNING", dedupeKey: `ROLLBACK:${a.id}`, title: `Retour arrière de « ${a.label} » impossible : ${first}`, detail: `${first}${manual}` });
      throw new DecisionError(`Retour arrière automatique impossible : ${first}${manual}`);
    }
    try {
      remote = await rollbackPriceLabsWrite(p, actor.tenantId, a.id, { recheck: async () => { const again = await guard(); if (again) throw new WriteError(again); } });
    } catch (e) {
      const m = e instanceof WriteError ? e.message : "erreur technique pendant le retour arrière";
      await audit(db, actor.tenantId, userActor(actor.id), "action.rollback_failed", "RevenueAction", a.id, `Retour arrière de « ${a.label} » en échec : ${m}`, { actionType: a.type, code: e instanceof WriteError ? e.code : "TECH" }).catch(() => {});
      await raiseAlert({ tenantId: actor.tenantId, propertyId: a.propertyId, actionId: a.id, writeId: e instanceof WriteError ? e.writeId : null, kind: "ROLLBACK_FAILED", dedupeKey: `ROLLBACK:${a.id}`, title: `Retour arrière de « ${a.label} » en échec`, detail: m });
      throw e instanceof WriteError ? new DecisionError(m) : e;
    }
  }
  await db.transaction(async (tx) => {
    if (a.execution?.mode === "DEMO_SIMULATED" || a.execution?.mode === "PRICELABS_API") {
      if (a.execution.mode === "DEMO_SIMULATED") for (const d of (Array.isArray(a.execution.before) ? a.execution.before : [])) await tx.update(calendarDays).set({ priceCents: d.priceCents, minStay: d.minStay, rule: d.rule }).where(and(eq(calendarDays.propertyId, a.propertyId), eq(calendarDays.date, d.date)));
      // la stratégie locale s'aligne sur la valeur réellement remise chez PriceLabs (à défaut, celle consignée à l'exécution) ; sur un logement réel, une valeur
      // modifiée localement depuis l'action n'est pas écrasée
      const prevBase = remote?.restoredLimits.baseCents ?? a.execution.previousBasePriceCents, prevMin = remote?.restoredLimits.minCents ?? a.execution.previousMinPriceCents;
      if (a.type === "BASE_PRICE_CHANGE" && typeof prevBase === "number" && prevBase > 0) {
        const [p] = await tx.select().from(properties).where(and(eq(properties.id, a.propertyId), eq(properties.tenantId, actor.tenantId)));
        await commitStrategy(tx, { tenantId: actor.tenantId, propertyId: p.id, next: (s) => (remote && s.basePriceCents !== a.parameters.basePriceCents ? s : { ...s, basePriceCents: prevBase }), source: "ACTION_ROLLBACK", createdBy: actor.id });
      }
      if (a.type === "MIN_PRICE_CHANGE" && typeof prevMin === "number" && prevMin > 0) {
        const [p] = await tx.select().from(properties).where(and(eq(properties.id, a.propertyId), eq(properties.tenantId, actor.tenantId)));
        await commitStrategy(tx, { tenantId: actor.tenantId, propertyId: p.id, next: (s) => (remote && s.minPriceCents !== a.parameters.minPriceCents ? s : { ...s, minPriceCents: prevMin }), source: "ACTION_ROLLBACK", createdBy: actor.id });
      }
    } else if (a.execution?.mode === "MANUAL_DECLARED") {
      if (a.execution.createdPromotionId) await tx.update(promotions).set({ status: "ENDED", endedAt: new Date(), endReason: "Retour arrière de l'action", updatedAt: new Date() }).where(and(eq(promotions.id, a.execution.createdPromotionId), eq(promotions.tenantId, actor.tenantId)));
      if (a.type === "PROMO_REMOVAL") await tx.update(promotions).set({ status: "ACTIVE", endedAt: null, endReason: null, updatedAt: new Date() }).where(and(eq(promotions.id, a.parameters.promotionId), eq(promotions.tenantId, actor.tenantId)));
    }
    await move(tx, a.id, actor.tenantId, a.status as ActionState, "ROLLED_BACK", { execution: { ...a.execution, rollback: { at: new Date().toISOString(), reason: reason.trim() || null, manual: a.execution?.mode === "MANUAL_DECLARED", ...(remote ? { writeIds: remote.writeIds, noop: remote.noop, adapter: remote.adapter } : {}) } } });
    // une ligne restée « en préparation » (arrêt brutal) n'a jamais eu d'issue connue : elle passe en « envoyée, non confirmée », l'état réel ayant été remis par le retour arrière
    await tx.update(schema.externalWrites).set({ status: "SENT", error: "Issue inconnue (arrêt du serveur) : état remis par le retour arrière.", updatedAt: new Date() }).where(and(eq(schema.externalWrites.actionId, a.id), eq(schema.externalWrites.tenantId, actor.tenantId), eq(schema.externalWrites.status, "PENDING")));
    await audit(tx, actor.tenantId, userActor(actor.id), "action.rolled_back", "RevenueAction", a.id, `Retour arrière sur « ${a.label} »${reason ? " — " + reason.trim() : ""}. Plan : ${a.rollbackPlan}`, { actionType: a.type, fromStatus: a.status, reason: reason.trim() || null, rollbackPlan: a.rollbackPlan, ...(remote ? { writeIds: remote.writeIds, remoteNoop: remote.noop } : {}) });
  });
  // US-094 : l'action est revenue en arrière, les alertes qui la concernaient n'ont plus d'objet
  await resolveAlerts(actor.tenantId, a.id, "Retour arrière effectué.");
}

/** US-094 : prise en compte d'une alerte d'exécution par une personne habilitée à décider. L'alerte reste visible, sans nouvel e-mail. */
export async function acknowledge(actor: Actor, alertId: string) {
  await requirePermission(actor, "action.rollback", "Alert", alertId);
  const al = await getAlert(actor.tenantId, alertId);
  if (!al) throw new DecisionError("Alerte introuvable.", "NOT_FOUND");
  if (al.status !== "OPEN") throw new DecisionError("Cette alerte a déjà été prise en compte ou résolue : rechargez la page.");
  const done = await acknowledgeAlert(actor.tenantId, alertId, actor.id);
  if (!done) throw new DecisionError("Cette alerte vient de changer d'état : rechargez la page.");
  await audit(db, actor.tenantId, userActor(actor.id), "alert.acknowledged", "RevenueAction", al.actionId ?? al.id, `Alerte « ${al.title} » prise en compte par ${actor.name}.`, { alertId, kind: al.kind });
}

/**
 * US-094 : reprise d'une action restée « en exécution » (arrêt du serveur). Aucune décision automatique : une personne vérifie PriceLabs, puis marque l'action
 * comme interrompue. Elle passe en échec ; le retour arrière reste possible et repart de l'état réel chez PriceLabs (ce qui n'a pas été écrit est sauté).
 */
export async function interruptStuck(actor: Actor, actionId: string) {
  await requirePermission(actor, "action.rollback", "RevenueAction", actionId);
  const a = await getAction(actor.tenantId, actionId);
  if (a.status !== "EXECUTING") throw new DecisionError("Cette action n'est plus en exécution : rechargez la page.");
  if (+new Date() - +a.updatedAt < STUCK_AFTER_MS) throw new DecisionError("Cette action est en exécution depuis moins de 15 minutes : laissez-lui le temps de se terminer.");
  const message = "Exécution interrompue (arrêt du serveur ?), marquée comme telle par une personne. L'écriture a pu partir chez PriceLabs : vérifiez la grille, ou lancez le retour arrière qui remet les valeurs d'avant.";
  await db.transaction(async (tx) => {
    await move(tx, a.id, actor.tenantId, "EXECUTING", "FAILED", { execution: { error: message } });
    // l'appel resté « en préparation » n'a pas d'issue connue : « envoyée, non confirmée », pour que le journal ne le relève plus à chaque passage
    await tx.update(schema.externalWrites).set({ status: "SENT", error: "Issue inconnue (exécution interrompue) : à vérifier dans PriceLabs.", updatedAt: new Date() }).where(and(eq(schema.externalWrites.actionId, a.id), eq(schema.externalWrites.tenantId, actor.tenantId), eq(schema.externalWrites.status, "PENDING")));
    await audit(tx, actor.tenantId, userActor(actor.id), "action.failed", "RevenueAction", a.id, `« ${a.label} » marquée comme interrompue par ${actor.name} : ${message}`, { actionType: a.type, interrupted: true });
  });
  await resolveAlerts(actor.tenantId, a.id, "Action marquée comme interrompue.", ["STUCK", "STUCK_WRITE"]);
}

/**
 * Mesure prudente (blueprint §17.4) : on compare les nuits réservées avant et après, sans témoin.
 * Une réservation survenue après l'action n'est jamais présentée comme causée par elle.
 */
export async function measureDueActions(tenantId: string, today: ISODate): Promise<number> {
  const due = await db.select().from(revenueActions).where(and(eq(revenueActions.tenantId, tenantId), eq(revenueActions.status, "MEASURING"), lte(revenueActions.measureDueAt, today)));
  let done = 0;
  for (const a of due) try {
    const [o] = await db.select().from(opportunities).where(eq(opportunities.id, a.opportunityId));
    const after = await bookedCount(a.propertyId, o.stayFrom, o.stayTo);
    const before = a.execution?.baseline ?? null;
    const gained = before ? after.bookedNights - before.bookedNights : null;
    const measurement = {
      outcome: gained === null ? "INCONCLUSIVE" : gained > 0 ? "POSITIVE" : "NEUTRAL",
      observed: gained === null ? "Référence avant action inconnue." : `${after.bookedNights} nuits réservées sur la période contre ${before.bookedNights} avant l'action.`,
      interpretation: gained !== null && gained > 0 ? "Des nuits se sont vendues après l'action. Sans période témoin, ce résultat reste une corrélation." : "Aucune nuit supplémentaire vendue pendant la fenêtre d'observation.",
      incrementalCents: null, confidence: "faible", measuredAt: new Date().toISOString(), baseline: before, after,
    };
    await db.transaction(async (tx) => {
      await move(tx, a.id, tenantId, "MEASURING", "CLOSED", { measurement });
      await tx.insert(agentRuns).values({ id: newId("run"), tenantId, agentId: "reporting", opportunityId: o.id, operation: "measure", mode: "DETERMINISTIC", summary: `Mesure de « ${a.label} » (${o.code}) : ${measurement.observed} Effet incrémental inconnu.` });
      await audit(tx, tenantId, agentActor("reporting"), "experiment.measured", "RevenueAction", a.id, `Mesure de « ${a.label} » : résultat ${measurement.outcome === "POSITIVE" ? "positif (corrélation)" : measurement.outcome === "NEUTRAL" ? "neutre" : "non concluant"}.`, { code: o.code, outcome: measurement.outcome, observed: measurement.observed });
    });
    done++;
  } catch (e) { console.error("[mesure] action ignorée", a.id, (e as Error).message); }
  return done;
}
