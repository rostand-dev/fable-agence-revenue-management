/**
 * Écriture unitaire d'une réservation SuperHote (US-031) : le seul chemin par lequel un webhook (US-030) ou la réconciliation (US-032)
 * modifie une réservation. Idempotent (rejouer le même état ne change rien), protégé contre l'ordre d'arrivée (un état plus ancien que
 * celui déjà connu est ignoré) et transactionnel : la réservation, ses nuits et son historique réussissent ou échouent ensemble.
 * Les écritures d'un même logement sont sérialisées par un verrou de transaction (deux webhooks simultanés ne se croisent pas).
 * L'appelant ouvre la transaction par `withTenant` (isolation par la base) ; `tenantId` doit être celui du logement.
 */
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import type { EconomicModel } from "../engine/types";
import { dedupeConfirmed, type PlReservation } from "../integrations/pricelabs-map";
import type { ShReservation } from "../integrations/superhote-map";
import { calendarPatches, shReservations } from "../integrations/superhote-reservations";
import { affectedWindow, diffReservation, type ChangeKind, type FieldChange, type Snap } from "../reservations/nights";
import { addDays, type ISODate } from "../dates";
import { snapOf, writeNights } from "./reservations-store";

const { reservations, reservationChanges, calendarDays } = schema;
export type IngestTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type IngestSource = "WEBHOOK" | "RECONCILE";

export type IngestInput = {
  tenantId: string; propertyId: string; model: EconomicModel | null; reservation: ShReservation;
  source: IngestSource; deliveryId?: string | null;
};
export type IngestResult = {
  /** STALE : état plus ancien que celui déjà connu, ignoré. UNCHANGED : identique, rien écrit. */
  outcome: ChangeKind | "STALE";
  externalId: string; status: Snap["status"] | null;
  /** Nuits à recalculer (calendrier, métriques) ; null si rien n'a changé. */
  window: { from: ISODate; to: ISODate } | null;
  changes: FieldChange[];
};

const toDate = (iso: string | null): Date | null => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(+d) ? null : d; };

export async function applyReservation(tx: IngestTx, input: IngestInput): Promise<IngestResult> {
  const { tenantId, propertyId, reservation, source } = input;
  const incoming = shReservations([reservation], input.model)[0] as PlReservation;
  const externalId = incoming.externalId, at = toDate(reservation.updatedAt);
  // sérialise tout ce qui touche ce logement : la création concurrente d'une même réservation et la réévaluation des chevauchements
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"res:" + propertyId}, 0))`);
  const [existing] = await tx.select().from(reservations).where(and(eq(reservations.tenantId, tenantId), eq(reservations.propertyId, propertyId), eq(reservations.externalId, externalId))).for("update");

  // plus ancien que l'état connu, ou sans date alors qu'un état daté existe : ignoré (la réconciliation, qui lit `updated_at`, tranchera). À date égale, le dernier arrivé gagne.
  if (existing?.sourceUpdatedAt && (!at || +at < +existing.sourceUpdatedAt)) return { outcome: "STALE", externalId, status: existing.status as Snap["status"], window: null, changes: [] };

  const after: Snap = snapOf({ status: incoming.status, channel: incoming.channel, checkIn: incoming.checkIn, checkOut: incoming.checkOut, grossRoomCents: incoming.grossRoomCents, cleaningCents: incoming.cleaningCents, commissionCents: incoming.commissionCents, paymentFeeCents: incoming.paymentFeeCents });
  const before: Snap | null = existing ? snapOf({ ...existing, status: existing.status as Snap["status"] }) : null;
  // un doublon connu (chevauchement) reste évalué comme une réservation confirmée : c'est la réévaluation des chevauchements qui tranche
  const comparable = before && before.status === "DUPLICATE" ? { ...before, status: "CONFIRMED" as const } : before;
  const { kind, changes } = diffReservation(comparable, after);

  if (existing && kind === "UNCHANGED") {
    if (at && (!existing.sourceUpdatedAt || +at > +existing.sourceUpdatedAt)) await tx.update(reservations).set({ sourceUpdatedAt: at }).where(eq(reservations.id, existing.id));
    return { outcome: "UNCHANGED", externalId, status: before!.status, window: null, changes: [] };
  }

  const values = { channel: after.channel, checkIn: after.checkIn, checkOut: after.checkOut, nights: incoming.nights, grossRoomCents: after.grossRoomCents, cleaningCents: after.cleaningCents, commissionCents: after.commissionCents, paymentFeeCents: after.paymentFeeCents, status: after.status, bookedAt: incoming.bookedAt, source: "SUPERHOTE", sourceUpdatedAt: at ?? existing?.sourceUpdatedAt ?? null, updatedAt: new Date() };
  const id = existing ? existing.id : newId("res");
  if (existing) await tx.update(reservations).set(values).where(eq(reservations.id, id));
  else await tx.insert(reservations).values({ id, tenantId, propertyId, externalId, ...values });
  await writeNights(tx, tenantId, propertyId, id, after);

  const win = affectedWindow(before, after);
  const finalStatus = await reevaluateOverlaps(tx, tenantId, propertyId, win, externalId, after.status, source, input.deliveryId ?? null, at);
  // l'historique décrit l'état réellement stocké (un doublon détecté par la réévaluation y figure comme tel)
  const stored: Snap = { ...after, status: finalStatus };
  const d2 = finalStatus === after.status ? { kind, changes } : diffReservation(comparable, stored);
  const finalKind = d2.kind === "UNCHANGED" ? kind : d2.kind;
  await tx.insert(reservationChanges).values({ id: newId("rch"), tenantId, propertyId, externalId, kind: finalKind, source, deliveryId: input.deliveryId ?? null, occurredAt: at, before, after: stored, changes: d2.changes });
  return { outcome: finalKind, externalId, status: finalStatus, window: win, changes: d2.changes };
}

/**
 * Un logement ne se réserve pas deux fois la même nuit : si des réservations confirmées se chevauchent après ce changement, la règle commune
 * (`dedupeConfirmed`) marque le reliquat DUPLICATE, et une réservation redevenue seule (l'autre est annulée) redevient CONFIRMED. Renvoie le statut final de `externalId`.
 */
async function reevaluateOverlaps(tx: IngestTx, tenantId: string, propertyId: string, win: { from: ISODate; to: ISODate }, externalId: string, current: Snap["status"], source: IngestSource, deliveryId: string | null, at: Date | null): Promise<Snap["status"]> {
  const rows = await tx.select().from(reservations).where(and(eq(reservations.tenantId, tenantId), eq(reservations.propertyId, propertyId), inArray(reservations.status, ["CONFIRMED", "DUPLICATE"]), lt(reservations.checkIn, win.to), gt(reservations.checkOut, win.from)));
  const pl: PlReservation[] = rows.map((r) => ({ externalId: r.externalId, channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, grossRoomCents: r.grossRoomCents, cleaningCents: r.cleaningCents, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents, status: "CONFIRMED", bookedAt: r.bookedAt, commissionEstimated: false }));
  dedupeConfirmed(pl);
  const next = new Map(pl.map((r) => [r.externalId, r.status]));
  let final = current;
  for (const r of rows) {
    const status = next.get(r.externalId)!;
    if (r.externalId === externalId) final = status;
    if (status === r.status) continue;
    await tx.update(reservations).set({ status, updatedAt: new Date() }).where(eq(reservations.id, r.id));
    await writeNights(tx, tenantId, propertyId, r.id, snapOf({ ...r, status }));
    // une autre réservation bascule (doublon ↔ confirmée) : son historique le dit, sinon ses nuits disparaîtraient sans trace
    if (r.externalId !== externalId) {
      const b = snapOf({ ...r, status: r.status as Snap["status"] }), a = { ...b, status };
      await tx.insert(reservationChanges).values({ id: newId("rch"), tenantId, propertyId, externalId: r.externalId, kind: "MODIFIED", source, deliveryId, occurredAt: at, before: b, after: a, changes: diffReservation(b, a).changes });
    }
  }
  return final;
}

/**
 * Répercute sur le calendrier déjà lu les nuits d'une fenêtre : vendues si une réservation les couvre ; libérées seulement si SuperHote les
 * déclare disponibles (`shCalendar` vide = aucune libération : la réconciliation corrigera). Les prix ne bougent pas. Renvoie le nombre de nuits modifiées.
 */
export async function applyCalendarEffect(tx: IngestTx, propertyId: string, win: { from: ISODate; to: ISODate }, shCalendar: { date: string; available: boolean }[], today: ISODate): Promise<number> {
  const from = win.from < today ? today : win.from;
  if (from >= win.to) return 0;
  const days = await tx.select().from(calendarDays).where(and(eq(calendarDays.propertyId, propertyId), gt(calendarDays.date, addDays(from, -1)), lt(calendarDays.date, win.to)));
  const rows = await tx.select({ checkIn: reservations.checkIn, checkOut: reservations.checkOut, status: reservations.status }).from(reservations).where(and(eq(reservations.propertyId, propertyId), inArray(reservations.status, ["CONFIRMED", "BLOCKED"]), lt(reservations.checkIn, win.to), gt(reservations.checkOut, from)));
  const patches = calendarPatches(days, rows as Pick<PlReservation, "checkIn" | "checkOut" | "status">[], shCalendar, today);
  for (const c of patches) await tx.update(calendarDays).set({ state: c.state, priceCents: c.priceCents, sentPriceCents: c.sentPriceCents }).where(and(eq(calendarDays.propertyId, propertyId), eq(calendarDays.date, c.date)));
  return patches.length;
}
