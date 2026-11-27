import { and, desc, eq, gte, inArray, lt, ne, or, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { freshnessOf } from "../freshness";
import { todayISO, type ISODate } from "../dates";
import { computeBaseline, type Baseline, type BaselineInput, type BookedNight } from "../experiments/baseline";
import { classifyOutcome, type OutcomeResult } from "../experiments/outcome";
import { clipStay, COMPARABLE_OFFSET_DAYS, effectiveDateOf, observationWindow, shiftWindow, type DateWindow } from "../experiments/windows";

const { experiments, experimentMeasurements, reservationNights, reservations, calendarDays } = schema;
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

export type MeasurementRow = typeof experimentMeasurements.$inferSelect;

/** Nuits vendues du logement sur une fenêtre de séjours (avec leur date de réservation). */
export async function loadStayNights(tenantId: string, propertyId: string, stay: DateWindow): Promise<BookedNight[]> {
  const rows = await db.select({ night: reservationNights.night, bookedAt: reservations.bookedAt, channel: reservationNights.channel, gross: reservationNights.grossRoomCents, commission: reservationNights.commissionCents, fee: reservationNights.paymentFeeCents })
    .from(reservationNights).innerJoin(reservations, eq(reservations.id, reservationNights.reservationId))
    .where(and(eq(reservationNights.tenantId, tenantId), eq(reservationNights.propertyId, propertyId), eq(reservationNights.status, "CONFIRMED"), gte(reservationNights.night, stay.from), lt(reservationNights.night, stay.to)));
  return rows.map((r) => ({ night: r.night, bookedAt: r.bookedAt, channel: r.channel, grossRoomCents: r.gross, commissionCents: r.commission, paymentFeeCents: r.fee }));
}

/**
 * La source des réservations est-elle assez récente pour qu'une absence de réservation veuille dire quelque chose ? (blueprint §7.4 : réservations < 24 h)
 * Démonstration : toujours (données synthétiques). Logement relié à SuperHote (ou, à défaut, à PriceLabs) : dernière lecture réussie et récente. Sans aucune liaison,
 * aucune date de synchronisation n'existe : rien n'est opposé (saisie manuelle), la limite est dite dans « Méthode » et la documentation.
 */
export async function reservationsFreshFor(tenantId: string, propertyId: string, now = new Date()): Promise<boolean> {
  const [p] = await db.select({ isDemo: schema.properties.isDemo, superhote: schema.properties.superhote, pricelabs: schema.properties.pricelabs }).from(schema.properties).where(and(eq(schema.properties.id, propertyId), eq(schema.properties.tenantId, tenantId)));
  return !p || reservationsFresh(p, now);
}

type ReservationLink = { isDemo: boolean; superhote: unknown; pricelabs: unknown };
type LinkedSources = { sh: { rentalId?: string; lastSync?: { ok?: boolean; at?: string } } | null; pl: { listingId?: string; lastSync?: { ok?: boolean; at?: string } } | null };
const linkedSources = (p: ReservationLink): LinkedSources => ({ sh: p.superhote as LinkedSources["sh"], pl: p.pricelabs as LinkedSources["pl"] });

/** Le logement lit-il ses réservations chez une source (SuperHote ou PriceLabs) ? Non : saisie manuelle, aucune date de synchronisation n'existe. */
export function reservationsLinked(p: ReservationLink): boolean {
  const { sh, pl } = linkedSources(p);
  return !!(sh?.rentalId || pl?.listingId);
}

/** Même règle que `reservationsFreshFor`, sur un logement déjà lu. */
export function reservationsFresh(p: ReservationLink, now = new Date()): boolean {
  if (p.isDemo) return true;
  // SuperHote fait foi pour les réservations ; sans SuperHote, PriceLabs les porte (même règle que le rythme de synchronisation, cadence.ts)
  const { sh, pl } = linkedSources(p);
  const src = sh?.rentalId ? sh.lastSync : pl?.listingId ? pl.lastSync : undefined;
  if (src === undefined && !reservationsLinked(p)) return true; // aucune source reliée : saisie manuelle, rien n'est opposé (limite dite dans « Méthode »)
  if (src?.ok === false) return false;
  return freshnessOf("RESERVATIONS", src?.at, now).state === "FRESH";
}

/**
 * Autres expériences non annulées du même logement dont les séjours se recoupent et qui s'observent en même temps (leurs effets ne se séparent pas).
 * Une expérience pas encore vérifiée n'a pas de fin d'observation : elle compte dès qu'elle a commencé avant la fin de celle qu'on mesure (choix prudent).
 */
export async function countOverlapping(tenantId: string, x: Pick<ExperimentRow, "id" | "propertyId" | "stayFrom" | "stayTo" | "effectiveOn" | "observeFrom" | "observeTo">): Promise<number> {
  if (!x.stayFrom || !x.stayTo) return 0;
  const rows = await db.select({ id: experiments.id, stayFrom: experiments.stayFrom, stayTo: experiments.stayTo, effectiveOn: experiments.effectiveOn, observeTo: experiments.observeTo, status: experiments.status })
    .from(experiments).where(and(eq(experiments.tenantId, tenantId), eq(experiments.propertyId, x.propertyId), ne(experiments.id, x.id), ne(experiments.status, "CANCELLED")));
  const myFrom = x.observeFrom ?? x.effectiveOn, myTo = x.observeTo ?? "9999-12-31";
  return rows.filter((o) => {
    if (!o.stayFrom || !o.stayTo || !(o.stayFrom < x.stayTo! && x.stayFrom! < o.stayTo)) return false;
    // sans fin connue : une expérience pas encore mesurée reste ouverte ; une expérience déjà mesurée (héritée) s'est arrêtée à son entrée en vigueur
    const oTo = o.observeTo ?? (o.status === "MEASURED" ? o.effectiveOn : "9999-12-31");
    return o.effectiveOn < myTo && myFrom < oTo;
  }).length;
}

/**
 * Mesure l'expérience d'une action arrivée au bout de sa fenêtre d'observation (US-111) : lit les nuits vendues, classe le résultat, écrit la mesure
 * (immuable) dans la transaction fournie. Une action sans expérience (cas d'une base antérieure à l'épic) reçoit une expérience héritée, donc une mesure non concluante.
 */
export async function measureExperiment(tx: Exec, a: { id: string; tenantId: string; propertyId: string; opportunityId: string; executedAt: Date | null; createdAt: Date; execution: any }, stay: DateWindow, now = new Date()): Promise<{ result: OutcomeResult; experimentId: string; legacy: boolean }> {
  let [x] = await tx.select().from(experiments).where(and(eq(experiments.actionId, a.id), eq(experiments.tenantId, a.tenantId)));
  if (!x) {
    const eff = effectiveDateOf((a.execution as any)?.declaredDate, a.executedAt ?? a.createdAt);
    const legacy = { version: 0, legacy: true, sufficient: false, limits: ["LEGACY"], onBooks: (a.execution as any)?.baseline ?? null };
    await tx.insert(experiments).values({ id: newId("exp"), tenantId: a.tenantId, propertyId: a.propertyId, actionId: a.id, opportunityId: a.opportunityId, status: "OBSERVING", effectiveOn: eff, stayFrom: stay.from, stayTo: stay.to, baselineFrom: eff, baselineTo: eff, baseline: legacy }).onConflictDoNothing({ target: experiments.actionId });
    [x] = await tx.select().from(experiments).where(and(eq(experiments.actionId, a.id), eq(experiments.tenantId, a.tenantId)));
  }
  const legacy = isLegacyBaseline(x.baseline);
  const baseline = legacy ? null : (x.baseline as Baseline);
  const observation = windowsOf(x).observation;
  const bstay = baseline?.stay;
  const [nights, fresh, overlapping] = await Promise.all([
    bstay ? loadStayNights(a.tenantId, a.propertyId, { from: bstay.from, to: bstay.to }) : Promise.resolve([] as BookedNight[]),
    reservationsFreshFor(a.tenantId, a.propertyId, now),
    countOverlapping(a.tenantId, x),
  ]);
  const result = classifyOutcome({ baseline, observation, nights, reservationsFresh: fresh, overlapping });
  const metrics = { baselinePerDay: baseline?.pickup?.perDay ?? null, baselineWindow: baseline?.window ?? null, stay: bstay ?? null, observedNights: result.observed?.nights ?? null, observedPerDay: result.observed?.perDay ?? null, observationDays: result.observationDays, expectedNights: result.expectedNights, deltaNights: result.deltaNights, relativeChange: result.relativeChange, baseNetPerNight: result.baseNetPerNight, observedNetPerNight: result.observedNetPerNight, comparableYearNights: baseline?.comparable.available ? baseline.comparable.pickupNights : null };
  await tx.insert(experimentMeasurements).values({
    id: newId("mes"), tenantId: a.tenantId, propertyId: a.propertyId, experimentId: x.id, actionId: a.id, outcome: result.outcome, reasons: result.reasons, observeFrom: observation?.from ?? null, observeTo: observation?.to ?? null,
    metrics, summary: result.summary, interpretation: result.interpretation, confidence: result.confidence, legacy, measuredAt: now,
  }).onConflictDoNothing({ target: experimentMeasurements.experimentId });
  return { result, experimentId: x.id, legacy };
}

/** Mesure d'une action (fiche dossier, historique, rapport). */
export async function getMeasurementOfAction(tenantId: string, actionId: string): Promise<MeasurementRow | null> {
  const [row] = await db.select().from(experimentMeasurements).where(and(eq(experimentMeasurements.actionId, actionId), eq(experimentMeasurements.tenantId, tenantId)));
  return row ?? null;
}
