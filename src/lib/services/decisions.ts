import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { addDays, todayISO, type ISODate } from "../dates";
import { assertTransition, type ActionState } from "../engine/stateMachine";
import type { Candidate } from "../engine/types";

const { opportunities, revenueActions, auditEvents, calendarDays, promotions, properties, integrations, agentRuns } = schema;
type Actor = { id: string; name: string; tenantId: string };
export class DecisionError extends Error {}

async function audit(tenantId: string, actor: string, type: string, entity: string, entityId: string, summary: string, payload?: any) {
  await db.insert(auditEvents).values({ id: newId("evt"), tenantId, actor, type, entity, entityId, summary, payload });
}
async function move(actionId: string, tenantId: string, from: ActionState, to: ActionState, patch: Partial<typeof revenueActions.$inferInsert> = {}) {
  assertTransition(from, to);
  await db.update(revenueActions).set({ ...patch, status: to, updatedAt: new Date() }).where(and(eq(revenueActions.id, actionId), eq(revenueActions.tenantId, tenantId), eq(revenueActions.status, from)));
}
async function getOpp(tenantId: string, id: string) {
  const [o] = await db.select().from(opportunities).where(and(eq(opportunities.id, id), eq(opportunities.tenantId, tenantId)));
  if (!o) throw new DecisionError("Dossier introuvable.");
  return o;
}
async function getAction(tenantId: string, id: string) {
  const [a] = await db.select().from(revenueActions).where(and(eq(revenueActions.id, id), eq(revenueActions.tenantId, tenantId)));
  if (!a) throw new DecisionError("Action introuvable.");
  return a;
}
export function commentRequired(c: Candidate): boolean { return c.audit.verdict === "NEEDS_HUMAN" || c.risk === "HIGH" || c.risk === "CRITICAL"; }

/** Approbation : seule une option non rejetée par l'auditeur peut être approuvée, et jamais par un agent. */
export async function approve(actor: Actor, opportunityId: string, candidateIndex: number, comment: string): Promise<string | null> {
  const o = await getOpp(actor.tenantId, opportunityId);
  if (o.status !== "OPEN") throw new DecisionError("Ce dossier n'est plus ouvert.");
  const c = o.candidates[candidateIndex] as Candidate | undefined;
  if (!c) throw new DecisionError("Option inconnue.");
  if (c.audit.verdict === "REJECT") throw new DecisionError("Cette option est rejetée par l'auditeur : elle ne peut pas être approuvée.");
  if (commentRequired(c) && comment.trim().length < 8) throw new DecisionError("Un commentaire est obligatoire pour cette option (risque élevé ou validation demandée par l'auditeur).");
  if (c.type === "NO_ACTION") {
    await db.update(opportunities).set({ status: "DECIDED", decision: "NO_ACTION", selected: candidateIndex, deferUntil: c.reviewAt ?? null }).where(eq(opportunities.id, o.id));
    await audit(actor.tenantId, "user:" + actor.id, "opportunity.no_action", "Opportunity", o.id, `${actor.name} retient l'inaction sur ${o.code}${comment ? " — " + comment.trim() : ""}.`);
    return null;
  }
  const [p] = await db.select().from(properties).where(eq(properties.id, o.propertyId));
  const id = newId("act");
  await db.insert(revenueActions).values({
    id, tenantId: actor.tenantId, propertyId: o.propertyId, opportunityId: o.id, type: c.type, label: c.label, target: c.target, parameters: c.parameters,
    simulation: { current: c.current, proposed: c.proposed, expectedDeltaCents: c.expectedDeltaCents, hypothesis: c.hypothesis, executionMode: c.executionMode, measurementWindowDays: c.measurementWindowDays },
    audit: c.audit, status: "DRAFT", riskLevel: c.risk, rollbackPlan: c.rollbackPlan, idempotencyKey: `${o.id}:${candidateIndex}`,
  });
  // la chaîne d'états est rejouée explicitement : aucune mise à jour libre du statut
  await move(id, actor.tenantId, "DRAFT", "SIMULATED");
  await move(id, actor.tenantId, "SIMULATED", "AUDITED");
  await move(id, actor.tenantId, "AUDITED", "PENDING_APPROVAL");
  await move(id, actor.tenantId, "PENDING_APPROVAL", "APPROVED", { approvalComment: comment.trim() || null, approvedById: actor.id, approvedAt: new Date() });
  await db.update(opportunities).set({ status: "DECIDED", decision: p?.status === "SHADOW" ? "APPROVED_SHADOW" : "APPROVED", selected: candidateIndex }).where(eq(opportunities.id, o.id));
  await audit(actor.tenantId, "user:" + actor.id, "action.approved", "RevenueAction", id, `${actor.name} approuve « ${c.label} » (${o.code})${comment ? " — " + comment.trim() : ""}.`, { verdict: c.audit.verdict, risk: c.risk });
  return id;
}

export async function reject(actor: Actor, opportunityId: string, comment: string) {
  const o = await getOpp(actor.tenantId, opportunityId);
  if (o.status !== "OPEN") throw new DecisionError("Ce dossier n'est plus ouvert.");
  await db.update(opportunities).set({ status: "DECIDED", decision: "REJECTED" }).where(eq(opportunities.id, o.id));
  await audit(actor.tenantId, "user:" + actor.id, "opportunity.rejected", "Opportunity", o.id, `${actor.name} rejette la proposition du dossier ${o.code}${comment ? " — " + comment.trim() : ""}.`);
}
export async function defer(actor: Actor, opportunityId: string, days = 3) {
  const o = await getOpp(actor.tenantId, opportunityId);
  if (o.status !== "OPEN") throw new DecisionError("Ce dossier n'est plus ouvert.");
  if (o.veto) throw new DecisionError("Un dossier sous veto ne peut pas être différé.");
  const until = addDays(todayISO(), days);
  await db.update(opportunities).set({ status: "DEFERRED", deferUntil: until }).where(eq(opportunities.id, o.id));
  await audit(actor.tenantId, "user:" + actor.id, "opportunity.deferred", "Opportunity", o.id, `${actor.name} diffère le dossier ${o.code} jusqu'au ${until.split("-").reverse().join("/")}.`);
}
export async function reopen(actor: Actor, opportunityId: string) {
  const o = await getOpp(actor.tenantId, opportunityId);
  const acts = await db.select().from(revenueActions).where(eq(revenueActions.opportunityId, o.id));
  if (acts.some((a) => !["CANCELLED", "REJECTED"].includes(a.status))) throw new DecisionError("Une action existe déjà pour ce dossier : utilisez le retour arrière.");
  await db.update(opportunities).set({ status: "OPEN", decision: null, deferUntil: null }).where(eq(opportunities.id, o.id));
  await audit(actor.tenantId, "user:" + actor.id, "opportunity.reopened", "Opportunity", o.id, `${actor.name} rouvre le dossier ${o.code}.`);
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
  const o = await getOpp(actor.tenantId, a.opportunityId);
  const [p] = await db.select().from(properties).where(eq(properties.id, a.propertyId));
  if (a.status !== "APPROVED") throw new DecisionError("Seule une action approuvée peut être exécutée.");
  if (p.status === "SHADOW") throw new DecisionError("Logement en période d'observation : l'approbation est enregistrée comme jugement hypothétique, aucune écriture n'est faite.");
  const mode: string = a.simulation.executionMode;
  const provider = a.target.system === "PRICELABS" ? "pricelabs" : a.target.system === "BOOKING" ? "booking" : a.target.system === "AIRBNB" ? "airbnb" : null;
  if (provider) {
    const [i] = await db.select().from(integrations).where(and(eq(integrations.tenantId, actor.tenantId), eq(integrations.provider, provider)));
    if (i?.killSwitch) throw new DecisionError("Coupe-circuit actif sur cette intégration : aucune exécution possible.");
  }
  const dates: ISODate[] = a.parameters.dates ?? [];
  const baseline = await bookedCount(a.propertyId, o.stayFrom, o.stayTo);
  await move(a.id, actor.tenantId, "APPROVED", "EXECUTING");
  let execution: any;
  try {
    if (mode === "API_PRICELABS") {
      if (!p.isDemo) throw new DecisionError("L'écriture PriceLabs par API n'est pas encore connectée pour ce logement : utilisez la procédure manuelle.");
      const before = dates.length ? await db.select().from(calendarDays).where(and(eq(calendarDays.propertyId, p.id), inArray(calendarDays.date, dates))) : [];
      // précondition : l'état relu doit être celui sur lequel la simulation a été faite
      if (before.some((d) => d.state !== "FREE")) throw new DecisionError("Recontrôle : une des nuits a été réservée depuis la simulation. Écriture abandonnée, relancez la revue.");
      for (const d of before) {
        const patch: Partial<typeof calendarDays.$inferInsert> = {};
        if (a.type === "MIN_STAY_OVERRIDE") patch.minStay = a.parameters.minStay;
        else if (a.type === "RULE_EXCLUSION") { patch.priceCents = a.parameters.nightlyCents; patch.rule = null; }
        else if (a.parameters.restoresFloor) patch.priceCents = a.parameters.nightlyCents;
        else if (typeof a.parameters.changePct === "number" && d.priceCents !== null) patch.priceCents = Math.round(d.priceCents * (1 + a.parameters.changePct / 100) / 100) * 100;
        await db.update(calendarDays).set(patch).where(and(eq(calendarDays.propertyId, p.id), eq(calendarDays.date, d.date)));
      }
      if (a.type === "BASE_PRICE_CHANGE" && a.parameters.basePriceCents) {
        await db.update(properties).set({ strategy: { ...p.strategy, basePriceCents: a.parameters.basePriceCents }, strategyVersion: p.strategyVersion + 1 }).where(eq(properties.id, p.id));
      }
      execution = { mode: "DEMO_SIMULATED", note: "Écriture PriceLabs simulée sur le logement de démonstration.", before: before.map((d) => ({ date: d.date, priceCents: d.priceCents, minStay: d.minStay, rule: d.rule })), previousBasePriceCents: p.strategy?.basePriceCents ?? null, baseline };
    } else if (mode === "MANUAL_RUNBOOK") {
      if (!declaration || declaration.scope.trim().length < 5 || !declaration.date) throw new DecisionError("Déclarez la portée réellement appliquée et la date d'application.");
      const ch = a.target.channel ?? a.parameters.channel;
      if (a.type === "CHANNEL_PROMO") {
        const pid = newId("promo");
        await db.insert(promotions).values({ id: pid, tenantId: actor.tenantId, propertyId: p.id, channel: ch, kind: a.parameters.kind, label: a.parameters.label ?? a.label, discountPct: a.parameters.discountPct, stayFrom: a.parameters.stayFrom, stayTo: a.parameters.stayTo, status: "ACTIVE", source: "DECLARED", verifiedAt: new Date() });
        execution = { createdPromotionId: pid };
      } else if (a.type === "PROMO_REMOVAL") {
        await db.update(promotions).set({ status: "ENDED" }).where(and(eq(promotions.id, a.parameters.promotionId), eq(promotions.tenantId, actor.tenantId)));
      } else if (a.type === "INVESTIGATION" && ch) {
        await db.update(promotions).set({ verifiedAt: new Date() }).where(and(eq(promotions.propertyId, p.id), eq(promotions.channel, ch), eq(promotions.status, "ACTIVE")));
      }
      execution = { ...execution, mode: "MANUAL_DECLARED", declaredScope: declaration.scope.trim(), declaredDate: declaration.date, proof: declaration.proof.trim() || null, baseline };
    } else {
      execution = { mode: "INTERNAL", note: declaration?.scope?.trim() || "Tâche interne lancée.", baseline };
    }
  } catch (e) {
    await move(a.id, actor.tenantId, "EXECUTING", "FAILED", { execution: { error: String((e as Error).message) } });
    await audit(actor.tenantId, "system", "action.failed", "RevenueAction", a.id, `Échec d'exécution de « ${a.label} » : ${(e as Error).message}`);
    throw e;
  }
  await move(a.id, actor.tenantId, "EXECUTING", "EXECUTED", { execution, executedAt: new Date() });
  await audit(actor.tenantId, "user:" + actor.id, "action.executed", "RevenueAction", a.id, `« ${a.label} » exécutée (${execution.mode === "DEMO_SIMULATED" ? "écriture simulée, démonstration" : execution.mode === "MANUAL_DECLARED" ? "procédure manuelle déclarée" : "tâche interne"}).`);
}

/** Vérification : relecture de l'état réel. Pour une procédure manuelle, c'est une seconde relecture déclarée. */
export async function verify(actor: Actor, actionId: string) {
  const a = await getAction(actor.tenantId, actionId);
  if (a.status !== "EXECUTED") throw new DecisionError("Seule une action exécutée peut être vérifiée.");
  let check: any = { mode: "DECLARED", note: "Relecture déclarée par le propriétaire dans l'extranet officiel." };
  if (a.execution?.mode === "DEMO_SIMULATED") {
    const dates: ISODate[] = a.parameters.dates ?? [];
    const now = dates.length ? await db.select().from(calendarDays).where(and(eq(calendarDays.propertyId, a.propertyId), inArray(calendarDays.date, dates))) : [];
    const ok = a.type === "MIN_STAY_OVERRIDE" ? now.every((d) => d.minStay === a.parameters.minStay) : a.type === "RULE_EXCLUSION" ? now.every((d) => d.rule === null) : true;
    if (!ok) {
      await audit(actor.tenantId, "agent:audit", "action.verification_failed", "RevenueAction", a.id, `Vérification en échec pour « ${a.label} » : l'état relu diffère de l'action approuvée.`);
      throw new DecisionError("L'état relu diffère de l'action approuvée. Aucune correction n'est improvisée : lancez un retour arrière.");
    }
    check = { mode: "READ_BACK", note: `${now.length} nuit${now.length > 1 ? "s" : ""} relue${now.length > 1 ? "s" : ""} sur ${dates.length} dans la grille de démonstration, sans écart.` };
  }
  const due = addDays(todayISO(), a.simulation.measurementWindowDays || 7);
  await move(a.id, actor.tenantId, "EXECUTED", "VERIFIED", { verifiedAt: new Date(), execution: { ...a.execution, verification: check } });
  await move(a.id, actor.tenantId, "VERIFIED", "MEASURING", { measureDueAt: due });
  await audit(actor.tenantId, "agent:audit", "action.verified", "RevenueAction", a.id, `« ${a.label} » vérifiée ; mesure prévue le ${due.split("-").reverse().join("/")}.`);
}

export async function rollback(actor: Actor, actionId: string, reason: string) {
  const a = await getAction(actor.tenantId, actionId);
  if (!["EXECUTED", "VERIFIED", "MEASURING", "FAILED"].includes(a.status)) throw new DecisionError("Cette action ne peut pas être annulée dans son état actuel.");
  if (a.execution?.mode === "DEMO_SIMULATED") {
    for (const d of a.execution.before ?? []) await db.update(calendarDays).set({ priceCents: d.priceCents, minStay: d.minStay, rule: d.rule }).where(and(eq(calendarDays.propertyId, a.propertyId), eq(calendarDays.date, d.date)));
    if (a.type === "BASE_PRICE_CHANGE" && a.execution.previousBasePriceCents) {
      const [p] = await db.select().from(properties).where(eq(properties.id, a.propertyId));
      await db.update(properties).set({ strategy: { ...p.strategy, basePriceCents: a.execution.previousBasePriceCents }, strategyVersion: p.strategyVersion + 1 }).where(eq(properties.id, p.id));
    }
  } else if (a.execution?.mode === "MANUAL_DECLARED") {
    if (a.execution.createdPromotionId) await db.update(promotions).set({ status: "ENDED" }).where(eq(promotions.id, a.execution.createdPromotionId));
    if (a.type === "PROMO_REMOVAL") await db.update(promotions).set({ status: "ACTIVE" }).where(eq(promotions.id, a.parameters.promotionId));
  }
  await move(a.id, actor.tenantId, a.status as ActionState, "ROLLED_BACK", { execution: { ...a.execution, rollback: { at: new Date().toISOString(), reason: reason.trim() || null, manual: a.execution?.mode === "MANUAL_DECLARED" } } });
  await audit(actor.tenantId, "user:" + actor.id, "action.rolled_back", "RevenueAction", a.id, `Retour arrière sur « ${a.label} »${reason ? " — " + reason.trim() : ""}. Plan : ${a.rollbackPlan}`);
}

/**
 * Mesure prudente (blueprint §17.4) : on compare les nuits réservées avant et après, sans témoin.
 * Une réservation survenue après l'action n'est jamais présentée comme causée par elle.
 */
export async function measureDueActions(tenantId: string, today: ISODate): Promise<number> {
  const due = await db.select().from(revenueActions).where(and(eq(revenueActions.tenantId, tenantId), eq(revenueActions.status, "MEASURING"), lte(revenueActions.measureDueAt, today)));
  for (const a of due) {
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
    await move(a.id, tenantId, "MEASURING", "CLOSED", { measurement });
    await db.insert(agentRuns).values({ id: newId("run"), tenantId, agentId: "reporting", opportunityId: o.id, operation: "measure", mode: "DETERMINISTIC", summary: `Mesure de « ${a.label} » (${o.code}) : ${measurement.observed} Effet incrémental inconnu.` });
    await audit(tenantId, "agent:reporting", "experiment.measured", "RevenueAction", a.id, `Mesure de « ${a.label} » : résultat ${measurement.outcome === "POSITIVE" ? "positif (corrélation)" : measurement.outcome === "NEUTRAL" ? "neutre" : "non concluant"}.`);
  }
  return due.length;
}
