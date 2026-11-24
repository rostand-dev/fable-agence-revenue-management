import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { todayISO } from "@/lib/dates";
import { lastMonths, monthlyKpis } from "@/lib/engine/metrics";
import { can, denyMessage, PERMISSION_LABEL, ROLE_LABEL, type Permission, type Role } from "@/lib/rbac";
import { buildSnapshot, checkNarrative, draftNarrative, isReportableMonth, type ReportAction, type ReportSnapshot } from "@/lib/reports/monthly";
import { OUTCOMES, type Outcome } from "@/lib/experiments/outcome";
import { fmtMonth } from "@/lib/dates";

/**
 * Rapport mensuel certifié (US-112). Les écrans (actions serveur) passent tous par ici : mêmes droits, même isolation par propriétaire d'espace,
 * même journal d'audit (chaque écriture et son événement dans la même transaction). Aucun modèle de langage : le texte est assemblé par règles
 * à partir des métriques certifiées, et aucun nombre hors de l'instantané ne peut être certifié.
 */
const { monthlyReports, properties, reservations, marketDays, opportunities, experimentMeasurements, revenueActions } = schema;
export type ReportActor = { id: string; name: string; tenantId: string; role: Role };
export type ReportErrorCode = "NOT_FOUND" | "INVALID" | "CONFLICT" | "FORBIDDEN";
export class ReportError extends Error {
  constructor(public code: ReportErrorCode, message: string) { super(message); this.name = "ReportError"; }
}
const isOutcome = (v: string): v is Outcome => (OUTCOMES as readonly string[]).includes(v);
export type MonthlyReport = typeof monthlyReports.$inferSelect;
export type ReportView = Omit<MonthlyReport, "snapshot"> & { snapshot: ReportSnapshot };

/** Empreinte de ce qui est certifié : instantané + texte. Deux certifications du même contenu donnent la même empreinte. */
export const reportHash = (snapshot: unknown, narrative: string): string => createHash("sha256").update(JSON.stringify({ snapshot, narrative })).digest("hex");

async function need(actor: ReportActor, permission: Permission, propertyId: string) {
  if (can(actor.role, permission)) return;
  try {
    await recordAudit(db, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "access.denied", entity: "Property", entityId: propertyId.slice(0, 64), summary: `${actor.name} (${ROLE_LABEL[actor.role]}) : tentative refusée — ${PERMISSION_LABEL[permission]}`, payload: { permission } });
  } catch (e) { console.error("[rbac] refus non consigné", (e as Error).message); }
  throw new ReportError("FORBIDDEN", denyMessage(actor.role, permission));
}

async function propertyOf(tenantId: string, propertyId: string) {
  const [p] = await db.select({ id: properties.id, name: properties.name, isDemo: properties.isDemo }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new ReportError("NOT_FOUND", "Logement introuvable.");
  return p;
}
const view = (r: MonthlyReport): ReportView => ({ ...r, snapshot: r.snapshot as ReportSnapshot });

/** Instantané des métriques du mois : lu en base à l'instant de la génération, puis figé dans le rapport. */
export async function loadSnapshot(tenantId: string, propertyId: string, month: string, now: Date = new Date()): Promise<ReportSnapshot> {
  const p = await propertyOf(tenantId, propertyId);
  const [prevMonth] = lastMonths(`${month}-15`, 1);
  const resas = await db.select().from(reservations).where(and(eq(reservations.tenantId, tenantId), eq(reservations.propertyId, propertyId)));
  const [prev, cur] = monthlyKpis(resas, [prevMonth, month]);
  // sans nuit vendue le mois précédent, il n'y a pas de référence : tendances inconnues
  const hasPrev = prev.nights > 0;
  const days = (await db.select({ d: marketDays.date, o: marketDays.marketOccupancy }).from(marketDays).where(and(eq(marketDays.tenantId, tenantId), eq(marketDays.propertyId, propertyId))))
    .filter((r) => r.d.slice(0, 7) === month && r.o !== null);
  const dim = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const market = { occupancy: days.length * 2 >= dim ? days.reduce((a, r) => a + (r.o as number), 0) / days.length : null, days: days.length };

  const meas = await db.select({ m: experimentMeasurements, label: revenueActions.label, code: opportunities.code })
    .from(experimentMeasurements)
    .innerJoin(revenueActions, eq(revenueActions.id, experimentMeasurements.actionId))
    .innerJoin(opportunities, eq(opportunities.id, revenueActions.opportunityId))
    .where(and(eq(experimentMeasurements.tenantId, tenantId), eq(experimentMeasurements.propertyId, propertyId)))
    .orderBy(experimentMeasurements.measuredAt);
  const actions: ReportAction[] = meas.filter((r) => todayISO(r.m.measuredAt).slice(0, 7) === month).map((r) => ({
    code: r.code, label: r.label, outcome: isOutcome(r.m.outcome) ? r.m.outcome : "INCONCLUSIVE", summary: r.m.summary, interpretation: r.m.interpretation, reasons: r.m.reasons ?? [], legacy: r.m.legacy,
  }));

  const opps = await db.select().from(opportunities).where(and(eq(opportunities.tenantId, tenantId), eq(opportunities.propertyId, propertyId), inArray(opportunities.status, ["OPEN", "DECIDED"])));
  const decided = opps.filter((o) => o.status === "DECIDED" && o.decidedAt && todayISO(o.decidedAt).slice(0, 7) === month);
  const decisions = { total: decided.length, noAction: decided.filter((o) => o.decision === "NO_ACTION").length, rejected: decided.filter((o) => o.decision === "REJECTED").length, approved: decided.filter((o) => o.decision === "APPROVED" || o.decision === "APPROVED_SHADOW").length };
  const open = opps.filter((o) => o.status === "OPEN").map((o) => ({ code: o.code, title: o.title, option: (o.candidates as any[])[o.selected]?.label ?? null, veto: o.veto }));
  return buildSnapshot({ month, now, property: p, current: cur, previous: hasPrev ? prev : null, market, actions, decisions, open });
}

/** Rapports d'un logement (ou de tous), le plus récent mois d'abord, puis la version la plus haute. */
export async function listReports(tenantId: string, propertyId?: string): Promise<ReportView[]> {
  const where = propertyId ? and(eq(monthlyReports.tenantId, tenantId), eq(monthlyReports.propertyId, propertyId)) : eq(monthlyReports.tenantId, tenantId);
  const rows = await db.select().from(monthlyReports).where(where).orderBy(desc(monthlyReports.month), desc(monthlyReports.version));
  return rows.map(view);
}
export async function getReport(tenantId: string, id: string): Promise<ReportView | null> {
  const [r] = await db.select().from(monthlyReports).where(and(eq(monthlyReports.id, id), eq(monthlyReports.tenantId, tenantId)));
  return r ? view(r) : null;
}
async function reportOf(tenantId: string, id: string): Promise<MonthlyReport> {
  const [r] = await db.select().from(monthlyReports).where(and(eq(monthlyReports.id, id), eq(monthlyReports.tenantId, tenantId)));
  if (!r) throw new ReportError("NOT_FOUND", "Rapport introuvable.");
  return r;
}

/** Un instantané plus ancien que cela ne se certifie plus sans être actualisé : des réservations ont pu changer depuis. */
export const MAX_SNAPSHOT_AGE_DAYS = 7;
/** Verrou le temps de la transaction : préparer, retoucher et certifier un même mois passent l'un après l'autre. */
const lockMonth = (tx: Pick<typeof db, "execute">, propertyId: string, month: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`report:${propertyId}:${month}`}))`);

/**
 * Prépare le rapport d'un mois terminé : première version, ou nouvelle version quand la précédente est certifiée (la certifiée reste intacte).
 * Si un brouillon existe, ses chiffres sont relus ; un texte retouché à la main n'est écrasé que sur demande explicite (`replaceEdits`).
 * Seuls les 24 derniers mois s'ouvrent ; un mois déjà rapporté reste corrigeable quel que soit son âge.
 */
export async function draftReport(actor: ReportActor, propertyId: string, month: string, opts: { replaceEdits?: boolean } = {}, now: Date = new Date()): Promise<ReportView> {
  const p = await propertyOf(actor.tenantId, propertyId);
  await need(actor, "report.certify", propertyId);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month >= todayISO(now).slice(0, 7)) throw new ReportError("INVALID", "Ce mois n'est pas ouvert à un rapport : seuls les mois terminés peuvent être rapportés.");
  const snapshot = await loadSnapshot(actor.tenantId, propertyId, month, now);
  const narrative = draftNarrative(snapshot);
  return db.transaction(async (tx) => {
    await lockMonth(tx, propertyId, month);
    const rows = await tx.select().from(monthlyReports).where(and(eq(monthlyReports.tenantId, actor.tenantId), eq(monthlyReports.propertyId, propertyId), eq(monthlyReports.month, month))).orderBy(desc(monthlyReports.version));
    if (rows.length === 0 && !isReportableMonth(month, todayISO(now))) throw new ReportError("INVALID", "Ce mois n'est pas ouvert à un rapport : seuls les 24 derniers mois terminés peuvent être rapportés.");
    const draft = rows.find((r) => r.status === "DRAFT");
    if (draft) {
      if (draft.edited && !opts.replaceEdits) throw new ReportError("CONFLICT", "Ce brouillon contient un texte retouché : régénérer l'écraserait. Confirmez pour repartir du texte automatique.");
      const [u] = await tx.update(monthlyReports).set({ snapshot, narrative, edited: false, updatedAt: now }).where(and(eq(monthlyReports.id, draft.id), eq(monthlyReports.tenantId, actor.tenantId), eq(monthlyReports.status, "DRAFT"))).returning();
      if (!u) throw new ReportError("CONFLICT", "Le rapport vient d'être certifié par une autre personne.");
      await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "report.drafted", entity: "MonthlyReport", entityId: draft.id, summary: `${actor.name} a régénéré le brouillon du rapport de ${fmtMonth(month)} (${p.name}), version ${draft.version}.`, payload: { month, version: draft.version, regenerated: true } });
      return view(u);
    }
    const version = (rows[0]?.version ?? 0) + 1;
    const id = newId("rpt");
    const [c] = await tx.insert(monthlyReports).values({ id, tenantId: actor.tenantId, propertyId, month, version, status: "DRAFT", snapshot, narrative, edited: false, createdBy: userActor(actor.id), createdAt: now, updatedAt: now }).returning();
    await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: version > 1 ? "report.reopened" : "report.drafted", entity: "MonthlyReport", entityId: id, summary: version > 1 ? `${actor.name} a ouvert la version ${version} du rapport de ${fmtMonth(month)} (${p.name}), la version ${version - 1} certifiée restant intacte.` : `${actor.name} a préparé le rapport de ${fmtMonth(month)} (${p.name}).`, payload: { month, version } });
    return view(c);
  });
}

/** Brouillon relu sous verrou : ce qui est vérifié est exactement ce qui est écrit, même si quelqu'un régénère au même instant. */
async function lockedDraft(tx: Pick<typeof db, "execute" | "select">, tenantId: string, id: string, already: string): Promise<MonthlyReport> {
  const [head] = await tx.select({ propertyId: monthlyReports.propertyId, month: monthlyReports.month }).from(monthlyReports).where(and(eq(monthlyReports.id, id), eq(monthlyReports.tenantId, tenantId)));
  if (!head) throw new ReportError("NOT_FOUND", "Rapport introuvable.");
  await lockMonth(tx, head.propertyId, head.month);
  const [r] = await tx.select().from(monthlyReports).where(and(eq(monthlyReports.id, id), eq(monthlyReports.tenantId, tenantId)));
  if (!r) throw new ReportError("NOT_FOUND", "Rapport introuvable.");
  if (r.status !== "DRAFT") throw new ReportError("CONFLICT", already);
  return r;
}

/** Enregistre un texte retouché (brouillon seulement). Refusé s'il cite un nombre absent de l'instantané, s'il retire une mention d'inconnue, attribue un effet aux actions, ou est vide ou trop long. */
export async function saveReport(actor: ReportActor, reportId: string, text: string, now: Date = new Date()): Promise<ReportView> {
  const r0 = await reportOf(actor.tenantId, reportId);
  await need(actor, "report.certify", r0.propertyId);
  return db.transaction(async (tx) => {
    const r = await lockedDraft(tx, actor.tenantId, reportId, "Ce rapport est certifié : ouvrez une nouvelle version pour le corriger.");
    const snap = r.snapshot as ReportSnapshot;
    const c = checkNarrative(text, snap);
    if (!c.ok) throw new ReportError("INVALID", c.error);
    const [u] = await tx.update(monthlyReports).set({ narrative: c.text, edited: c.text !== draftNarrative(snap), updatedAt: now }).where(and(eq(monthlyReports.id, r.id), eq(monthlyReports.tenantId, actor.tenantId), eq(monthlyReports.status, "DRAFT"))).returning();
    await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "report.edited", entity: "MonthlyReport", entityId: r.id, summary: `${actor.name} a retouché le texte du rapport de ${fmtMonth(r.month)}, version ${r.version}.`, payload: { month: r.month, version: r.version, edited: u.edited } });
    return view(u);
  });
}

/**
 * Certifie : le texte (celui que la personne a sous les yeux, s'il est fourni) est revérifié contre l'instantané lu sous verrou, puis enregistré, certifié et empreinté dans une seule transaction.
 * Refusé si les chiffres ont été lus il y a plus de 7 jours. Irréversible (une correction ouvre une nouvelle version).
 */
export async function certifyReport(actor: ReportActor, reportId: string, text?: string, now: Date = new Date()): Promise<ReportView> {
  const r0 = await reportOf(actor.tenantId, reportId);
  await need(actor, "report.certify", r0.propertyId);
  return db.transaction(async (tx) => {
    const r = await lockedDraft(tx, actor.tenantId, reportId, "Ce rapport est déjà certifié.");
    const snap = r.snapshot as ReportSnapshot;
    if (now.getTime() - new Date(snap.generatedAt).getTime() > MAX_SNAPSHOT_AGE_DAYS * 86_400_000) throw new ReportError("INVALID", `Les chiffres ont été lus il y a plus de ${MAX_SNAPSHOT_AGE_DAYS} jours : actualisez-les avant de certifier.`);
    const c = checkNarrative(text ?? r.narrative, snap);
    if (!c.ok) throw new ReportError("INVALID", c.error);
    const hash = reportHash(snap, c.text);
    const [u] = await tx.update(monthlyReports).set({ narrative: c.text, edited: c.text !== draftNarrative(snap), status: "CERTIFIED", certifiedBy: userActor(actor.id), certifiedByName: actor.name, certifiedHash: hash, certifiedAt: now, updatedAt: now }).where(and(eq(monthlyReports.id, r.id), eq(monthlyReports.tenantId, actor.tenantId), eq(monthlyReports.status, "DRAFT"))).returning();
    await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "report.certified", entity: "MonthlyReport", entityId: r.id, summary: `${actor.name} a certifié le rapport de ${fmtMonth(r.month)} (${snap.property.name}), version ${r.version}.`, payload: { month: r.month, version: r.version, hash, generatedAt: snap.generatedAt } });
    return view(u);
  });
}
