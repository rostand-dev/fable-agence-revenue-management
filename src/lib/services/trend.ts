import { and, eq, gte, inArray, lt, min } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayISO, type ISODate } from "../dates";
import { computeKpi, monthPeriod, type NightFact } from "../metrics/kpi";
import { compareMonths, trendMonths, type MonthTrend, type ReservationSource } from "../metrics/trend";
import { reservationsFresh, reservationsLinked } from "./experiments";
import { coverageOf } from "./performance";
import { PortfolioError } from "./portfolio";

const { properties, reservationNights, calendarDays } = schema;

/**
 * Tendances de plusieurs logements en trois lectures, filtrées sur l'espace : un identifiant d'un autre espace
 * est absent du résultat. Mêmes nuits que `getPerformance` (ventes confirmées, blocages des réservations et du calendrier).
 */
export async function monthTrends(tenantId: string, propertyIds: string[], now = new Date()): Promise<Map<string, MonthTrend>> {
  if (!propertyIds.length) return new Map();
  const { month, previousMonth } = trendMonths(todayISO(now));
  const current = monthPeriod(month), previous = monthPeriod(previousMonth);
  const [own, nightRows, calBlocked, firstRows] = await Promise.all([
    db.select({ id: properties.id, isDemo: properties.isDemo, superhote: properties.superhote, pricelabs: properties.pricelabs }).from(properties).where(and(eq(properties.tenantId, tenantId), inArray(properties.id, propertyIds))),
    db.select({ propertyId: reservationNights.propertyId, night: reservationNights.night, status: reservationNights.status, channel: reservationNights.channel, gross: reservationNights.grossRoomCents, commission: reservationNights.commissionCents, fee: reservationNights.paymentFeeCents })
      .from(reservationNights).where(and(eq(reservationNights.tenantId, tenantId), inArray(reservationNights.propertyId, propertyIds), gte(reservationNights.night, previous.from), lt(reservationNights.night, current.to))),
    db.select({ propertyId: calendarDays.propertyId, date: calendarDays.date }).from(calendarDays)
      .where(and(eq(calendarDays.tenantId, tenantId), inArray(calendarDays.propertyId, propertyIds), eq(calendarDays.state, "BLOCKED"), gte(calendarDays.date, previous.from), lt(calendarDays.date, current.to))),
    db.select({ propertyId: reservationNights.propertyId, first: min(reservationNights.night) }).from(reservationNights)
      .where(and(eq(reservationNights.tenantId, tenantId), inArray(reservationNights.propertyId, propertyIds))).groupBy(reservationNights.propertyId),
  ]);
  const first = new Map<string, ISODate | null>(firstRows.map((r) => [r.propertyId, r.first]));
  return new Map(own.map((p) => {
    const { id } = p;
    // même règle de fraîcheur que la mesure des actions : sans lecture récente, une absence de réservation ne prouve rien
    const source: ReservationSource = !reservationsFresh(p, now) ? "STALE" : p.isDemo || reservationsLinked(p) ? "FRESH" : "UNLINKED";
    const rows = nightRows.filter((r) => r.propertyId === id);
    const sold: NightFact[] = rows.filter((r) => r.status === "CONFIRMED").map((r) => ({ night: r.night, channel: r.channel, grossRoomCents: r.gross, commissionCents: r.commission, paymentFeeCents: r.fee }));
    const blocked = [...rows.filter((r) => r.status === "BLOCKED").map((r) => r.night), ...calBlocked.filter((r) => r.propertyId === id).map((r) => r.date)];
    return [id, compareMonths(computeKpi(current, sold, blocked), computeKpi(previous, sold, blocked), coverageOf(previous, first.get(id) ?? null), source)] as const;
  }));
}

/** Tendance d'un logement de l'espace ; logement inconnu ou d'un autre espace : 404. */
export async function monthTrend(tenantId: string, propertyId: string, now = new Date()): Promise<MonthTrend> {
  const t = (await monthTrends(tenantId, [propertyId], now)).get(propertyId);
  if (!t) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  return t;
}
