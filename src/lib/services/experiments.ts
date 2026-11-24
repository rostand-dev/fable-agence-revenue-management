import { and, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { todayISO, type ISODate } from "../dates";
import { computeBaseline, type Baseline, type BaselineInput, type BookedNight } from "../experiments/baseline";
import { clipStay, COMPARABLE_OFFSET_DAYS, observationWindow, shiftWindow, type DateWindow } from "../experiments/windows";

const { experiments, reservationNights, reservations, calendarDays } = schema;
type Exec = Pick<typeof db, "insert" | "update" | "select">;
export type ExperimentRow = typeof experiments.$inferSelect;
/** Baseline d'une expérience antérieure à l'épic 11 : l'état des séjours à l'exécution, sans fenêtre ni rythme (jamais reconstitués après coup). */
export type LegacyBaseline = { version: 0; legacy: true; sufficient: false; limits: ["LEGACY"]; onBooks?: { bookedNights: number; freeNights: number } | null };
export type StoredBaseline = Baseline | LegacyBaseline;
export const isLegacyBaseline = (b: StoredBaseline): b is LegacyBaseline => (b as LegacyBaseline).legacy === true;

export type ExperimentStatus = "AWAITING_VERIFICATION" | "OBSERVING" | "MEASURED" | "CANCELLED";
export const EXPERIMENT_STATUS_LABEL: Record<ExperimentStatus, string> = {
  AWAITING_VERIFICATION: "En attente de vérification",
  OBSERVING: "En observation",
  MEASURED: "Mesurée",
  CANCELLED: "Annulée",
};

/**
 * Lit ce dont la baseline a besoin : nuits vendues des séjours visés et d'un an plus tôt (avec leur date de réservation), nuits bloquées,
 * début de l'historique. Lecture seule, isolée par propriétaire d'espace.
 */
export async function loadBaselineInput(tenantId: string, propertyId: string, i: { stayFrom: ISODate; stayTo: ISODate; effectiveOn: ISODate; asOf: ISODate }): Promise<BaselineInput> {
  const stay = clipStay(i.stayFrom, i.stayTo, i.effectiveOn);
  const ranges: DateWindow[] = stay ? [stay, shiftWindow(stay, -COMPARABLE_OFFSET_DAYS)] : [];
  const nightsIn = (w: DateWindow) => and(gte(reservationNights.night, w.from), lt(reservationNights.night, w.to));
  const [sold, blocked, first] = await Promise.all([
    ranges.length
      ? db.select({ night: reservationNights.night, bookedAt: reservations.bookedAt, channel: reservationNights.channel, gross: reservationNights.grossRoomCents, commission: reservationNights.commissionCents, fee: reservationNights.paymentFeeCents })
        .from(reservationNights).innerJoin(reservations, eq(reservations.id, reservationNights.reservationId))
        .where(and(eq(reservationNights.tenantId, tenantId), eq(reservationNights.propertyId, propertyId), eq(reservationNights.status, "CONFIRMED"), or(nightsIn(ranges[0]), nightsIn(ranges[1]))))
      : Promise.resolve([]),
    stay
      ? Promise.all([
        db.select({ d: reservationNights.night }).from(reservationNights).where(and(eq(reservationNights.tenantId, tenantId), eq(reservationNights.propertyId, propertyId), eq(reservationNights.status, "BLOCKED"), nightsIn(stay))),
        db.select({ d: calendarDays.date }).from(calendarDays).where(and(eq(calendarDays.tenantId, tenantId), eq(calendarDays.propertyId, propertyId), eq(calendarDays.state, "BLOCKED"), gte(calendarDays.date, stay.from), lt(calendarDays.date, stay.to))),
      ])
      : Promise.resolve([[], []] as { d: string }[][]),
    db.select({ d: sql<string | null>`min(${reservations.bookedAt})`, s: sql<string | null>`min(${reservations.checkIn})` }).from(reservations).where(and(eq(reservations.tenantId, tenantId), eq(reservations.propertyId, propertyId), eq(reservations.status, "CONFIRMED"))),
  ]);
  const nights: BookedNight[] = sold.map((r) => ({ night: r.night, bookedAt: r.bookedAt, channel: r.channel, grossRoomCents: r.gross, commissionCents: r.commission, paymentFeeCents: r.fee }));
  return { ...i, nights, blocked: [...blocked[0], ...blocked[1]].map((r) => r.d), firstBookingDate: first[0]?.d ?? null, firstStayDate: first[0]?.s ?? null };
}

/** Calcule la baseline d'une action, au jour de l'entrée en vigueur. Lecture seule : à appeler AVANT l'écriture de l'action. */
export async function captureBaseline(tenantId: string, propertyId: string, stayFrom: ISODate, stayTo: ISODate, effectiveOn: ISODate, now = new Date()): Promise<Baseline> {
  return computeBaseline(await loadBaselineInput(tenantId, propertyId, { stayFrom, stayTo, effectiveOn, asOf: todayISO(now) }));
}

/** Enregistre l'expérience d'une action qui vient d'être exécutée (dans la transaction d'exécution : une action exécutée a toujours son expérience). Rejouable : une seule expérience par action. */
export async function createExperiment(tx: Exec, e: { tenantId: string; propertyId: string; actionId: string; opportunityId: string; effectiveOn: ISODate; baseline: Baseline }): Promise<void> {
  const b = e.baseline;
  await tx.insert(experiments).values({
    id: newId("exp"), tenantId: e.tenantId, propertyId: e.propertyId, actionId: e.actionId, opportunityId: e.opportunityId, status: "AWAITING_VERIFICATION", effectiveOn: e.effectiveOn,
    stayFrom: b.stay?.from ?? null, stayTo: b.stay?.to ?? null, baselineFrom: b.window.from, baselineTo: b.window.to, baseline: b,
  }).onConflictDoNothing({ target: experiments.actionId });
}

/** À la vérification de l'action : la fenêtre d'observation est fixée (de l'entrée en vigueur au jour de la mesure exclu). */
export async function startObservation(tx: Exec, tenantId: string, actionId: string, measureDueAt: ISODate): Promise<void> {
  const [row] = await tx.select({ effectiveOn: experiments.effectiveOn }).from(experiments).where(and(eq(experiments.actionId, actionId), eq(experiments.tenantId, tenantId)));
  if (!row) return;
  const w = observationWindow(row.effectiveOn, measureDueAt);
  // mesure prévue au plus tard le jour d'entrée en vigueur : aucune fenêtre (jamais une fenêtre inversée), la mesure sera non concluante
  await tx.update(experiments).set({ status: "OBSERVING", observeFrom: w?.from ?? null, observeTo: w?.to ?? null, updatedAt: new Date() })
    .where(and(eq(experiments.actionId, actionId), eq(experiments.tenantId, tenantId), eq(experiments.status, "AWAITING_VERIFICATION")));
}

/** Retour arrière : l'action n'a plus d'effet à mesurer. Une expérience déjà mesurée garde son résultat. */
export async function cancelExperiment(tx: Exec, tenantId: string, actionId: string): Promise<void> {
  await tx.update(experiments).set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(experiments.actionId, actionId), eq(experiments.tenantId, tenantId), inArray(experiments.status, ["AWAITING_VERIFICATION", "OBSERVING"])));
}

/** Expérience d'une action (fiche dossier). */
export async function getExperimentOfAction(tenantId: string, actionId: string): Promise<ExperimentRow | null> {
  const [row] = await db.select().from(experiments).where(and(eq(experiments.actionId, actionId), eq(experiments.tenantId, tenantId)));
  return row ?? null;
}

/** Expériences d'un logement, les plus récentes d'abord. */
export async function listExperiments(tenantId: string, opts: { propertyId?: string; limit?: number } = {}): Promise<ExperimentRow[]> {
  return db.select().from(experiments).where(and(eq(experiments.tenantId, tenantId), opts.propertyId ? eq(experiments.propertyId, opts.propertyId) : undefined)).orderBy(desc(experiments.createdAt)).limit(Math.min(Math.max(opts.limit ?? 100, 1), 500));
}

/** Fenêtres affichables d'une expérience : séjours, référence (null pour une expérience héritée, sans fenêtre), observation (null tant que non fixée). */
export function windowsOf(x: Pick<ExperimentRow, "stayFrom" | "stayTo" | "baselineFrom" | "baselineTo" | "observeFrom" | "observeTo">) {
  return {
    stay: x.stayFrom && x.stayTo ? { from: x.stayFrom, to: x.stayTo } : null,
    baseline: x.baselineFrom < x.baselineTo ? { from: x.baselineFrom, to: x.baselineTo } : null,
    observation: x.observeFrom && x.observeTo ? { from: x.observeFrom, to: x.observeTo } : null,
  };
}

/** À la clôture de la mesure : l'expérience est mesurée (une expérience annulée le reste). */
export async function markMeasured(tx: Exec, tenantId: string, actionId: string): Promise<void> {
  await tx.update(experiments).set({ status: "MEASURED", updatedAt: new Date() })
    .where(and(eq(experiments.actionId, actionId), eq(experiments.tenantId, tenantId), inArray(experiments.status, ["AWAITING_VERIFICATION", "OBSERVING"])));
}
