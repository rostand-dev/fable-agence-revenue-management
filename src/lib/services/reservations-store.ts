import { and, eq, inArray } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import type { PlReservation } from "../integrations/pricelabs-map";

const { reservations } = schema;
export type ReservationSource = "SUPERHOTE" | "PRICELABS";
type Tx = Pick<typeof db, "delete" | "insert">;

/**
 * Remplace les réservations lues d'un logement (jamais les réservations de démonstration) par celles de la source donnée.
 * Une réservation vient d'une seule source à la fois : SuperHote dès qu'il est rattaché, PriceLabs sinon.
 */
export async function replaceReservations(tx: Tx, tenantId: string, propertyId: string, rows: PlReservation[], source: ReservationSource): Promise<void> {
  await tx.delete(reservations).where(and(eq(reservations.propertyId, propertyId), inArray(reservations.source, ["PRICELABS", "SUPERHOTE"])));
  for (let i = 0; i < rows.length; i += 200) await tx.insert(reservations).values(rows.slice(i, i + 200).map(({ commissionEstimated, ...r }) => ({ id: newId("res"), tenantId, propertyId, ...r, source }))).onConflictDoNothing();
}
