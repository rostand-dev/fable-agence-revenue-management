import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { addDays, todayISO, type ISODate } from "../dates";
import { computePace, STLY_OFFSET_DAYS, type BookedNight, type CancelledNight, type WindowPace } from "../metrics/pace";
import { cancelledFromChanges } from "../reservations/cancellations";
import { nightsOf } from "../reservations/nights";
import { PortfolioError } from "./portfolio";

const { properties, reservations, reservationNights, reservationChanges, calendarDays } = schema;

export type PaceView = { propertyId: string; generatedAt: string; today: ISODate; firstBookingDate: ISODate | null; windows: WindowPace[] };

/**
 * Pickup et pacing d'un logement (US-051), lecture seule, isolée par locataire. Les nuits viennent de `reservation_nights` (date de réservation
 * jointe), les annulations de l'historique `reservation_changes` : une annulation compte tant que la réservation n'a pas été réactivée depuis.
 */
export async function getPace(tenantId: string, propertyId: string, now = new Date()): Promise<PaceView> {
  const [p] = await db.select({ id: properties.id }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  const today = todayISO(now);
  const lo = addDays(today, -STLY_OFFSET_DAYS), hi = addDays(today, 91);
  const sinceCancel = addDays(today, -14); // marge d'un jour : la borne exacte (jour civil de Paris) est tranchée plus bas
  const [rows, calBlocked, first, changes] = await Promise.all([
    db.select({ night: reservationNights.night, status: reservationNights.status, bookedAt: reservations.bookedAt })
      .from(reservationNights).innerJoin(reservations, eq(reservations.id, reservationNights.reservationId))
      .where(and(eq(reservationNights.tenantId, tenantId), eq(reservationNights.propertyId, propertyId), gte(reservationNights.night, lo), lt(reservationNights.night, hi))),
    db.select({ date: calendarDays.date }).from(calendarDays).where(and(eq(calendarDays.tenantId, tenantId), eq(calendarDays.propertyId, propertyId), eq(calendarDays.state, "BLOCKED"), gte(calendarDays.date, lo), lt(calendarDays.date, hi))),
    db.select({ d: sql<string | null>`min(${reservations.bookedAt})`, s: sql<string | null>`min(${reservations.checkIn})` }).from(reservations).where(and(eq(reservations.tenantId, tenantId), eq(reservations.propertyId, propertyId), eq(reservations.status, "CONFIRMED"))),
    // dernier évènement connu de chaque réservation touchée récemment : seules celles dont il est une annulation comptent
    db.select({ externalId: reservationChanges.externalId, kind: reservationChanges.kind, before: reservationChanges.before, after: reservationChanges.after, createdAt: reservationChanges.createdAt })
      .from(reservationChanges).where(and(eq(reservationChanges.tenantId, tenantId), eq(reservationChanges.propertyId, propertyId), gte(reservationChanges.createdAt, new Date(sinceCancel + "T00:00:00Z")))).orderBy(reservationChanges.createdAt),
  ]);
  const booked: BookedNight[] = rows.filter((r) => r.status === "CONFIRMED").map((r) => ({ night: r.night, bookedAt: r.bookedAt }));
  const blocked: ISODate[] = [...rows.filter((r) => r.status === "BLOCKED").map((r) => r.night), ...calBlocked.map((r) => r.date)];
  const cancelledBy = cancelledFromChanges(changes);
  const since14 = addDays(today, -13);
  const cancelled: CancelledNight[] = [];
  for (const { before, at } of cancelledBy) {
    if (at < since14) continue;
    for (const n of nightsOf({ ...before, status: "CONFIRMED" })) cancelled.push({ night: n.night, cancelledAt: at });
  }
  const firstBookingDate = first[0]?.d ?? null, firstStayDate = first[0]?.s ?? null;
  return { propertyId, generatedAt: now.toISOString(), today, firstBookingDate, windows: computePace({ today, booked, cancelled, blocked, firstBookingDate, firstStayDate }) };
}
