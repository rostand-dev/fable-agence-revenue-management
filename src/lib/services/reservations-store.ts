import { and, eq, inArray } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import type { PlReservation } from "../integrations/pricelabs-map";
import { nightsOf, type Snap } from "../reservations/nights";

const { reservations, reservationNights } = schema;
export type ReservationSource = "SUPERHOTE" | "PRICELABS" | "DEMO";
type Tx = Pick<typeof db, "delete" | "insert">;

export const snapOf = (r: Pick<Snap, keyof Snap>): Snap => ({ status: r.status, channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, grossRoomCents: r.grossRoomCents, cleaningCents: r.cleaningCents, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents });

/** Remplace les nuits d'une réservation par celles de son état courant (aucune si annulée ou doublon). */
export async function writeNights(tx: Tx, tenantId: string, propertyId: string, reservationId: string, snap: Snap): Promise<void> {
  await tx.delete(reservationNights).where(eq(reservationNights.reservationId, reservationId));
  const nights = nightsOf(snap);
  for (let i = 0; i < nights.length; i += 500) await tx.insert(reservationNights).values(nights.slice(i, i + 500).map((n) => ({ reservationId, tenantId, propertyId, ...n })));
}

/** Insère des réservations avec leurs nuits (US-031). Une réservation déjà présente (même logement, même identifiant) est laissée telle quelle. */
export async function insertReservations(tx: Tx, tenantId: string, propertyId: string, all: PlReservation[], source: ReservationSource): Promise<void> {
  const seen = new Set<string>(), rows = all.filter((r) => !seen.has(r.externalId) && !!seen.add(r.externalId)); // un identifiant en double dans le lot : la première occurrence l'emporte
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map(({ commissionEstimated, sourceUpdatedAt, ...r }) => ({ id: newId("res"), tenantId, propertyId, ...r, source, sourceUpdatedAt: sourceUpdatedAt ? new Date(sourceUpdatedAt) : null }));
    const inserted = await tx.insert(reservations).values(chunk).onConflictDoNothing().returning({ id: reservations.id, externalId: reservations.externalId });
    const byExt = new Map(chunk.map((c) => [c.externalId, c]));
    const nights = inserted.flatMap((x) => { const c = byExt.get(x.externalId); return c ? nightsOf(snapOf({ ...c, cleaningCents: c.cleaningCents ?? null, commissionCents: c.commissionCents ?? null, paymentFeeCents: c.paymentFeeCents ?? null, status: c.status as Snap["status"] })).map((n) => ({ reservationId: x.id, tenantId, propertyId, ...n })) : []; });
    for (let k = 0; k < nights.length; k += 500) await tx.insert(reservationNights).values(nights.slice(k, k + 500));
  }
}

/**
 * Remplace les réservations lues d'un logement (jamais les réservations de démonstration) par celles de la source donnée.
 * Une réservation vient d'une seule source à la fois : SuperHote dès qu'il est rattaché, PriceLabs sinon.
 * Les nuits suivent : supprimer une réservation supprime ses nuits (cascade), insérer en recrée.
 */
export async function replaceReservations(tx: Tx, tenantId: string, propertyId: string, rows: PlReservation[], source: Exclude<ReservationSource, "DEMO">): Promise<void> {
  await tx.delete(reservations).where(and(eq(reservations.propertyId, propertyId), inArray(reservations.source, ["PRICELABS", "SUPERHOTE"])));
  await insertReservations(tx, tenantId, propertyId, rows, source);
}
