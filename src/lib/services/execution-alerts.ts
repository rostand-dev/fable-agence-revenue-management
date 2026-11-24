import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { todayISO } from "../dates";
import { db, newId, schema } from "@/db";
import { recordAudit } from "../audit/log";
import { emailConfigured, sendEmail } from "../email/resend";
import { rolesWith } from "../rbac";
import { requestHash } from "../integrations/pricelabs-write";
import { readBackPriceLabsWrite, type SafePlan } from "./pricelabs-write";

// US-094 : alertes d'exécution PriceLabs. Une alerte naît au moment de l'échec (donc bien avant les 15 minutes du blueprint) ou à la surveillance planifiée
// (dérive, exécution bloquée). Une seule alerte non résolue par clé de dédoublonnage ; elle se résout d'elle-même quand la situation redevient conforme.
const { executionAlerts, revenueActions, externalWrites, properties, users } = schema;
export type Alert = typeof executionAlerts.$inferSelect;

export const ALERT_KINDS = {
  WRITE_FAILED: { severity: "WARNING", label: "Écriture refusée par PriceLabs" },
  WRITE_UNCONFIRMED: { severity: "CRITICAL", label: "Écriture non confirmée" },
  ROLLBACK_FAILED: { severity: "CRITICAL", label: "Retour arrière en échec" },
  PRECONDITION_FAILED: { severity: "WARNING", label: "Précondition non remplie" },
  DRIFT: { severity: "CRITICAL", label: "Écart chez PriceLabs" },
  STUCK: { severity: "CRITICAL", label: "Exécution bloquée" },
  STUCK_WRITE: { severity: "CRITICAL", label: "Écriture restée en préparation" },
  UNREADABLE: { severity: "WARNING", label: "Relecture impossible" },
  PROMO_MISMATCH: { severity: "WARNING", label: "Écart constaté dans l'extranet" },
} as const;
export type AlertKind = keyof typeof ALERT_KINDS;
export const isAlertKind = (k: string): k is AlertKind => k in ALERT_KINDS;

/** Une action restée « en exécution » plus longtemps est considérée comme bloquée (arrêt brutal du serveur, par exemple). */
export const STUCK_AFTER_MS = 15 * 60_000;
/** Une ligne de journal « en préparation » plus ancienne que cela n'a jamais été envoyée ou n'a jamais reçu de réponse. */
export const PENDING_AFTER_MS = 10 * 60_000;
/** Une action écrite est relue chez PriceLabs au plus une fois par cette durée. */
export const DRIFT_EVERY_MS = 6 * 3600_000;
/** Plafond de relectures par passage du planificateur : PriceLabs limite les appels (60 par minute). */
const DRIFT_BATCH = 8;

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (t: string, max: number) => (t.length > max ? t.slice(0, max - 1) + "…" : t);

export type RaiseInput = { tenantId: string; kind: AlertKind; severity?: "CRITICAL" | "WARNING"; /** résout les autres alertes du même type pour la même action (un nouvel écart remplace l'ancien) */ supersedes?: boolean; title: string; detail: string; propertyId?: string | null; actionId?: string | null; writeId?: string | null; dedupeKey: string };

/**
 * Lève une alerte. Retourne null si une alerte non résolue existe déjà pour la même clé (rien n'est dupliqué, aucun second e-mail).
 * Ne lève jamais d'exception : une alerte qui ne s'écrit pas ne doit pas masquer l'échec qu'elle signale.
 */
export async function raiseAlert(i: RaiseInput): Promise<Alert | null> {
  try {
    const [row] = await db.insert(executionAlerts).values({
      id: newId("alr"), tenantId: i.tenantId, propertyId: i.propertyId ?? null, actionId: i.actionId ?? null, writeId: i.writeId ?? null,
      kind: i.kind, severity: i.severity ?? ALERT_KINDS[i.kind].severity, title: clip(i.title, 200), detail: clip(i.detail, 1200), dedupeKey: clip(i.dedupeKey, 200),
    }).onConflictDoNothing({ target: [executionAlerts.tenantId, executionAlerts.dedupeKey], where: sql`status <> 'RESOLVED'` }).returning();
    if (!row) {
      // une alerte non résolue existe pour cette clé : si le motif a changé, elle est mise à jour, et rouverte si elle avait été prise en compte (le nouveau motif n'a pas été vu)
      const [cur] = await db.select().from(executionAlerts).where(and(eq(executionAlerts.tenantId, i.tenantId), eq(executionAlerts.dedupeKey, clip(i.dedupeKey, 200)), ne(executionAlerts.status, "RESOLVED")));
      const detail = clip(i.detail, 1200);
      if (!cur || cur.detail === detail) return null;
      const reopen = cur.status === "ACKNOWLEDGED";
      const [upd] = await db.update(executionAlerts).set({ detail, title: clip(i.title, 200), ...(reopen ? { status: "OPEN", acknowledgedBy: null, acknowledgedAt: null, notifiedAt: null } : {}) }).where(eq(executionAlerts.id, cur.id)).returning();
      if (reopen && upd) { await notifyAlert(upd).catch(() => {}); return upd; }
      return null;
    }
    if (i.supersedes && i.actionId) await db.update(executionAlerts).set({ status: "RESOLVED", resolvedAt: new Date(), resolution: "Remplacée par un écart plus récent." }).where(and(eq(executionAlerts.tenantId, i.tenantId), eq(executionAlerts.actionId, i.actionId), eq(executionAlerts.kind, i.kind), ne(executionAlerts.status, "RESOLVED"), ne(executionAlerts.id, row.id)));
    await recordAudit(db, { tenantId: i.tenantId, actor: "system", type: "alert.raised", entity: "RevenueAction", entityId: i.actionId ?? row.id, summary: `Alerte « ${ALERT_KINDS[i.kind].label} » : ${clip(i.title, 200)}`, payload: { alertId: row.id, kind: i.kind, severity: row.severity, writeId: i.writeId ?? null } }).catch(() => {});
    await notifyAlert(row).catch(() => {});
    return row;
  } catch (e) {
    console.error("[alertes] alerte non enregistrée", e instanceof Error ? e.message : e);
    return null;
  }
}

/** E-mail aux rôles qui peuvent décider, si l'envoi est configuré. Aucun secret ni donnée de voyageur : seulement le titre et le détail de l'alerte. */
async function notifyAlert(a: Alert): Promise<void> {
  if (!emailConfigured()) return;
  const to = await db.select({ email: users.email }).from(users).where(and(eq(users.tenantId, a.tenantId), inArray(users.role, rolesWith("action.rollback"))));
  if (!to.length) return;
  const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const link = base ? `${base}/alertes` : "";
  const subject = `[NuitSignal] ${a.severity === "CRITICAL" ? "Alerte critique" : "Alerte"} : ${ALERT_KINDS[a.kind as AlertKind]?.label ?? a.kind}`;
  const text = `${a.title}\n\n${a.detail}\n${link ? `\nVoir et traiter l'alerte : ${link}\n` : ""}`;
  const html = `<p><strong>${esc(a.title)}</strong></p><p>${esc(a.detail)}</p>${link ? `<p><a href="${esc(link)}">Voir et traiter l'alerte</a></p>` : ""}`;
  const sent = await Promise.all(to.map((r) => sendEmail({ to: r.email, subject, html, text, idempotencyKey: `${a.id}:${r.email}` })));
  if (sent.some(Boolean)) await db.update(executionAlerts).set({ notifiedAt: new Date() }).where(eq(executionAlerts.id, a.id));
}

/** Résout les alertes non résolues d'une action (toutes, ou seulement certains types) : la situation est redevenue conforme ou a été traitée. */
export async function resolveAlerts(tenantId: string, actionId: string, resolution: string, kinds?: AlertKind[]): Promise<number> {
  try {
    const rows = await db.update(executionAlerts).set({ status: "RESOLVED", resolvedAt: new Date(), resolution: clip(resolution, 300) })
      .where(and(eq(executionAlerts.tenantId, tenantId), eq(executionAlerts.actionId, actionId), ne(executionAlerts.status, "RESOLVED"), ...(kinds ? [inArray(executionAlerts.kind, kinds)] : []))).returning({ id: executionAlerts.id });
    return rows.length;
  } catch (e) { console.error("[alertes] résolution impossible", e instanceof Error ? e.message : e); return 0; }
}

/** Prise en compte par une personne : l'alerte reste visible, l'e-mail n'est pas renvoyé, et elle n'est pas relevée de nouveau pour le même écart. */
export async function acknowledgeAlert(tenantId: string, id: string, userId: string): Promise<Alert | null> {
  // un refus certain (rien n'a été modifié) ou une précondition non remplie n'a plus d'objet une fois vue : elle se referme
  const [cur] = await db.select({ kind: executionAlerts.kind }).from(executionAlerts).where(and(eq(executionAlerts.id, id), eq(executionAlerts.tenantId, tenantId)));
  const informative = cur?.kind === "WRITE_FAILED" || cur?.kind === "PRECONDITION_FAILED";
  const [row] = await db.update(executionAlerts).set({ status: informative ? "RESOLVED" : "ACKNOWLEDGED", acknowledgedBy: userId, acknowledgedAt: new Date(), ...(informative ? { resolvedAt: new Date(), resolution: "Prise en compte : rien n'avait été modifié." } : {}) })
    .where(and(eq(executionAlerts.id, id), eq(executionAlerts.tenantId, tenantId), eq(executionAlerts.status, "OPEN"))).returning();
  return row ?? null;
}

export async function getAlert(tenantId: string, id: string): Promise<Alert | null> {
  const [row] = await db.select().from(executionAlerts).where(and(eq(executionAlerts.id, id), eq(executionAlerts.tenantId, tenantId)));
  return row ?? null;
}

export async function listAlerts(tenantId: string, opts: { actionId?: string; resolvedLimit?: number } = {}) {
  const base = [eq(executionAlerts.tenantId, tenantId), ...(opts.actionId ? [eq(executionAlerts.actionId, opts.actionId)] : [])];
  const [active, resolved] = await Promise.all([
    db.select().from(executionAlerts).where(and(...base, ne(executionAlerts.status, "RESOLVED"))).orderBy(desc(executionAlerts.createdAt)),
    db.select().from(executionAlerts).where(and(...base, eq(executionAlerts.status, "RESOLVED"))).orderBy(desc(executionAlerts.resolvedAt)).limit(opts.resolvedLimit ?? 20),
  ]);
  return { active, resolved };
}

/** Nombre d'alertes à traiter (ouvertes, pas encore prises en compte) : pastille de la navigation. */
export async function openAlertCount(tenantId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(executionAlerts).where(and(eq(executionAlerts.tenantId, tenantId), eq(executionAlerts.status, "OPEN")));
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Surveillance planifiée (appelée par le planificateur toutes les 15 minutes)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
export type WatchResult = { stuck: number; pending: number; driftChecked: number; drift: number; resolved: number };

/** Actions bloquées en exécution, lignes de journal jamais parties, puis dérive des écritures déjà faites. Une erreur sur un élément n'arrête pas les autres. */
export async function runExecutionWatch(now = new Date()): Promise<WatchResult> {
  const out: WatchResult = { stuck: 0, pending: 0, driftChecked: 0, drift: 0, resolved: 0 };

  // 1) action restée « en exécution »
  const stuck = await db.select().from(revenueActions).where(and(eq(revenueActions.status, "EXECUTING"), lte(revenueActions.updatedAt, new Date(+now - STUCK_AFTER_MS))));
  for (const a of stuck) {
    const r = await raiseAlert({ tenantId: a.tenantId, propertyId: a.propertyId, actionId: a.id, kind: "STUCK", dedupeKey: `STUCK:${a.id}`,
      title: `« ${a.label} » est restée en exécution depuis plus de 15 minutes`,
      detail: "L'exécution ne s'est jamais terminée (arrêt du serveur ?). L'écriture a pu partir chez PriceLabs : vérifiez la grille dans PriceLabs, puis marquez l'action comme interrompue pour pouvoir lancer un retour arrière." });
    if (r) out.stuck++;
  }

  // 2) ligne de journal restée « en préparation » (plantage entre l'écriture au journal et l'envoi, ou envoi sans réponse) ; seulement si l'action n'est pas déjà traitée
  const pending = await db.select({ w: externalWrites }).from(externalWrites).innerJoin(revenueActions, eq(revenueActions.id, externalWrites.actionId))
    .where(and(eq(externalWrites.status, "PENDING"), lte(externalWrites.updatedAt, new Date(+now - PENDING_AFTER_MS)), inArray(revenueActions.status, ["EXECUTING", "EXECUTED", "VERIFIED", "MEASURING"])));
  for (const { w } of pending) {
    const r = await raiseAlert({ tenantId: w.tenantId, propertyId: w.propertyId, actionId: w.actionId, writeId: w.id, kind: "STUCK_WRITE", dedupeKey: `STUCK_WRITE:${w.id}`,
      title: `Une ${w.phase === "ROLLBACK" ? "étape de retour arrière" : "écriture"} PriceLabs est restée « en préparation »`,
      detail: "Le journal a gardé la trace de l'appel sans en connaître l'issue. Vérifiez la grille dans PriceLabs avant toute nouvelle tentative." });
    if (r) out.pending++;
  }

  // 3) fermeture automatique, en une requête chacune : l'action n'est plus en exécution, la ligne n'est plus en préparation, l'action est arrivée à un état final
  const close = async (cond: ReturnType<typeof sql>, why: string) => (await db.update(executionAlerts).set({ status: "RESOLVED", resolvedAt: now, resolution: why }).where(and(ne(executionAlerts.status, "RESOLVED"), cond)).returning({ id: executionAlerts.id })).length;
  out.resolved += await close(sql`${executionAlerts.kind} = 'STUCK' and ${executionAlerts.actionId} in (select id from revenue_actions where status <> 'EXECUTING')`, "L'action n'est plus en exécution.");
  out.resolved += await close(sql`${executionAlerts.kind} = 'STUCK_WRITE' and ${executionAlerts.writeId} in (select id from external_writes where status <> 'PENDING')`, "La ligne du journal n'est plus en préparation.");
  out.resolved += await close(sql`${executionAlerts.actionId} in (select id from revenue_actions where status in ('REJECTED','CANCELLED','EXPIRED','ROLLED_BACK','CLOSED'))`, "L'action est arrivée à un état final.");

  // 4) dérive : relecture des écritures déjà faites, au plus une action par logement et par passage (PriceLabs limite les appels)
  const dueCut = new Date(+now - DRIFT_EVERY_MS), today = todayISO(now), seen = new Set<string>();
  const cands = await db.select().from(revenueActions).where(and(inArray(revenueActions.status, ["EXECUTED", "VERIFIED", "MEASURING"]), sql`${revenueActions.execution}->>'mode' = 'PRICELABS_API'`, or(isNull(revenueActions.driftCheckedAt), lte(revenueActions.driftCheckedAt, dueCut)))).orderBy(sql`${revenueActions.driftCheckedAt} asc nulls first`).limit(DRIFT_BATCH * 4);
  let tried = 0;
  for (const a of cands) {
    if (tried >= DRIFT_BATCH) break;
    if (seen.has(a.propertyId)) continue;
    try {
      // réserve la relecture : un seul serveur la fait, même avec plusieurs instances
      const claimed = await db.update(revenueActions).set({ driftCheckedAt: now }).where(and(eq(revenueActions.id, a.id), or(isNull(revenueActions.driftCheckedAt), lte(revenueActions.driftCheckedAt, dueCut)))).returning({ id: revenueActions.id });
      if (!claimed.length) continue;
      const [p] = await db.select().from(properties).where(and(eq(properties.id, a.propertyId), eq(properties.tenantId, a.tenantId)));
      const plan = a.execution?.plan as SafePlan | undefined;
      if (!p || p.isDemo || !plan) continue;
      // une écriture plus récente du même type sur ce logement la remplace : ce n'est pas une dérive
      const [newer] = await db.select({ id: revenueActions.id }).from(revenueActions).where(and(eq(revenueActions.tenantId, a.tenantId), eq(revenueActions.propertyId, a.propertyId), eq(revenueActions.type, a.type), ne(revenueActions.id, a.id), inArray(revenueActions.status, ["EXECUTED", "VERIFIED", "MEASURING", "CLOSED"]), sql`${revenueActions.executedAt} > ${a.executedAt}`)).limit(1);
      if (newer) continue;
      // les prix datés d'une nuit passée disparaissent chez PriceLabs : on ne contrôle que les dates à venir
      const scoped: SafePlan = plan.kind === "OVERRIDES" ? { ...plan, items: plan.items.filter((it) => it.date >= today) } : plan;
      if (scoped.kind === "OVERRIDES" && !scoped.items.length) continue;
      seen.add(a.propertyId); tried++;
      let back;
      try { back = await readBackPriceLabsWrite(p, scoped); }
      catch (e) {
        // une relecture impossible (clé invalide, annonce supprimée, PriceLabs en panne) ne doit pas laisser une action sans surveillance sans le dire ; nouvel essai dans 1 h
        await db.update(revenueActions).set({ driftCheckedAt: new Date(+now - DRIFT_EVERY_MS + 3600_000) }).where(eq(revenueActions.id, a.id));
        await raiseAlert({ tenantId: a.tenantId, propertyId: a.propertyId, actionId: a.id, kind: "UNREADABLE", dedupeKey: `UNREADABLE:${a.id}`, title: `« ${a.label} » : PriceLabs n'a pas pu être relu`, detail: `${e instanceof Error ? e.message : "Relecture impossible"} L'écart éventuel n'est pas contrôlé tant que la lecture échoue.` });
        continue;
      }
      out.driftChecked++;
      await resolveAlerts(a.tenantId, a.id, "Relecture de nouveau possible.", ["UNREADABLE"]);
      if (back.mismatches.length) {
        const r = await raiseAlert({ tenantId: a.tenantId, propertyId: a.propertyId, actionId: a.id, kind: "DRIFT", supersedes: true, dedupeKey: `DRIFT:${a.id}:${requestHash(back.mismatches).slice(0, 12)}`,
          title: `« ${a.label} » : PriceLabs ne correspond plus à l'écriture faite`,
          detail: `${back.mismatches.join(" ; ")}. Quelqu'un a peut-être modifié la grille dans PriceLabs. Si ce n'est pas voulu, lancez un retour arrière ; sinon prenez l'alerte en compte.` });
        if (r) out.drift++;
      } else out.resolved += await resolveAlerts(a.tenantId, a.id, "Relecture chez PriceLabs conforme à l'écriture.", ["DRIFT"]);
    } catch (e) { console.error("[alertes] relecture de dérive impossible", a.id, e instanceof Error ? e.message : e); }
  }
  return out;
}

/** Tri stable des alertes pour l'affichage : critiques d'abord. */
export const bySeverity = (a: Alert, b: Alert) => (a.severity === b.severity ? +b.createdAt - +a.createdAt : a.severity === "CRITICAL" ? -1 : 1);
