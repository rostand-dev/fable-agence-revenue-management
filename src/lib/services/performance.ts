import { and, eq, gte, lt } from "drizzle-orm";
import { db, schema } from "@/db";
import { addDays, todayISO, type ISODate } from "../dates";
import { lastMonths, WINDOWS } from "../engine/metrics";
import { computeKpi, kpiByMonth, MAX_PERIOD_DAYS, monthPeriod, type Kpi, type NightFact } from "../metrics/kpi";
import { PortfolioError } from "./portfolio";

const { properties, reservationNights, calendarDays } = schema;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => ISO.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;

/** Part de la période couverte par l'historique lu : BEFORE_HISTORY = antérieure à la première nuit connue (les zéros sont alors des inconnus), PARTIAL = chevauche son début, FULL, NO_HISTORY = aucune nuit en base. */
export type Coverage = "FULL" | "PARTIAL" | "BEFORE_HISTORY" | "NO_HISTORY";
export function coverageOf(p: { from: ISODate; to: ISODate }, firstNight: ISODate | null): Coverage {
  if (!firstNight) return "NO_HISTORY";
  return p.to <= firstNight ? "BEFORE_HISTORY" : p.from < firstNight ? "PARTIAL" : "FULL";
}
export const DEFAULT_MONTHS = 12, MAX_MONTHS = 24;
export type PerformanceOptions = { from?: string | null; to?: string | null; months?: number | null };

export type PerformanceView = {
  propertyId: string; currency: "EUR"; generatedAt: string; today: ISODate;
  /** Période du KPI principal : nuits du `from` inclus au `to` exclu. `custom` : demandée par l'appelant ; sinon les derniers mois civils complets. */
  period: { from: ISODate; to: ISODate; custom: boolean };
  kpi: Kpi & { coverage: Coverage };
  /** Détail par mois civil : seulement quand la période est celle des derniers mois complets. */
  monthly: (Kpi & { month: string; coverage: Coverage })[] | null;
  /** Cinq fenêtres canoniques à venir (D+0–7 … D+61–90) : occupation déjà réservée, sans comparaison au marché. */
  horizons: { key: string; label: string; kpi: Kpi }[];
  dataQuality: { firstNight: ISODate | null; soldNightsUnknownCommission: number; overlappingNights: number };
};

/** Paramètres de période de l'API : même validation pour la route et les tests. */
export function parsePerformanceQuery(q: URLSearchParams): { ok: true; value: PerformanceOptions } | { ok: false; error: string } {
  const from = q.get("from"), to = q.get("to"), m = q.get("months");
  if ((from === null) !== (to === null)) return { ok: false, error: "Indiquez les deux dates `from` et `to`, ou aucune." };
  if (from !== null && to !== null) {
    if (m !== null) return { ok: false, error: "`months` ne se combine pas avec `from` et `to`." };
    if (!validDate(from) || !validDate(to)) return { ok: false, error: "Les dates sont au format AAAA-MM-JJ." };
    if (from >= to) return { ok: false, error: "`from` doit précéder `to` (nuits du `from` inclus au `to` exclu)." };
    return { ok: true, value: { from, to } };
  }
  if (m !== null) {
    const n = Number(m);
    if (!/^\d+$/.test(m) || n < 1 || n > MAX_MONTHS) return { ok: false, error: `\`months\` est un entier de 1 à ${MAX_MONTHS}.` };
    return { ok: true, value: { months: n } };
  }
  return { ok: true, value: {} };
}

/**
 * KPI d'un logement lus dans les nuits (`reservation_nights`, US-031) : nuits vendues confirmées, nuits bloquées (réservations de blocage et calendrier lu).
 * Lecture seule. Une période antérieure à la première nuit connue n'a pas de vraies valeurs nulles : `coverage` (BEFORE_HISTORY, PARTIAL, NO_HISTORY) dit que ces zéros sont des inconnus.
 */
export async function getPerformance(tenantId: string, propertyId: string, opts: PerformanceOptions = {}, now = new Date()): Promise<PerformanceView> {
  const [p] = await db.select({ id: properties.id }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  const today = todayISO(now);
  const custom = !!(opts.from && opts.to);
  const months = lastMonths(today, opts.months ?? DEFAULT_MONTHS);
  const main = custom ? { from: opts.from as ISODate, to: opts.to as ISODate } : { from: monthPeriod(months[0]).from, to: monthPeriod(months[months.length - 1]).to };
  const days = Math.round((Date.parse(main.to) - Date.parse(main.from)) / 86_400_000);
  if (days < 1 || days > MAX_PERIOD_DAYS) throw new PortfolioError("INVALID", `La période doit couvrir de 1 à ${MAX_PERIOD_DAYS} jours.`);

  const horizonsEnd = addDays(today, 91);
  const lo = [main.from, today].sort()[0], hi = [main.to, horizonsEnd].sort().reverse()[0];
  const [nightRows, calBlocked] = await Promise.all([
    db.select({ night: reservationNights.night, status: reservationNights.status, channel: reservationNights.channel, gross: reservationNights.grossRoomCents, commission: reservationNights.commissionCents, fee: reservationNights.paymentFeeCents })
      .from(reservationNights).where(and(eq(reservationNights.tenantId, tenantId), eq(reservationNights.propertyId, propertyId), gte(reservationNights.night, lo), lt(reservationNights.night, hi))),
    db.select({ date: calendarDays.date }).from(calendarDays).where(and(eq(calendarDays.tenantId, tenantId), eq(calendarDays.propertyId, propertyId), eq(calendarDays.state, "BLOCKED"), gte(calendarDays.date, lo), lt(calendarDays.date, hi))),
  ]);
  const sold: NightFact[] = nightRows.filter((r) => r.status === "CONFIRMED").map((r) => ({ night: r.night, channel: r.channel, grossRoomCents: r.gross, commissionCents: r.commission, paymentFeeCents: r.fee }));
  const blocked: ISODate[] = [...nightRows.filter((r) => r.status === "BLOCKED").map((r) => r.night), ...calBlocked.map((r) => r.date)];

  const [first] = await db.select({ n: reservationNights.night }).from(reservationNights).where(and(eq(reservationNights.tenantId, tenantId), eq(reservationNights.propertyId, propertyId))).orderBy(reservationNights.night).limit(1);
  const firstNight = first?.n ?? null;
  const kpi = { ...computeKpi(main, sold, blocked), coverage: coverageOf(main, firstNight) };
  const monthly = custom ? null : kpiByMonth(months, sold, blocked).map((k, i) => ({ ...k, month: months[i], coverage: coverageOf(k.period, firstNight) }));
  const horizons = WINDOWS.map((w) => ({ key: w.key, label: w.label, kpi: computeKpi({ from: addDays(today, w.from), to: addDays(today, w.to + 1) }, sold, blocked) }));
  const inMain = sold.filter((n) => n.night >= main.from && n.night < main.to);
  return {
    propertyId, currency: "EUR", generatedAt: now.toISOString(), today, period: { ...main, custom }, kpi, monthly, horizons,
    dataQuality: { firstNight, soldNightsUnknownCommission: inMain.filter((n) => n.commissionCents === null).length, overlappingNights: kpi.overlappingNights },
  };
}
