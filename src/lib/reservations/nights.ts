/**
 * Normalisation d'une réservation en nuits et en changements (US-031). Module pur : aucun accès base.
 *
 * Allocation : le montant d'hébergement (et la commission, les frais de paiement) est réparti sur les nuits en centimes entiers ;
 * le reste de la division va, un centime chacun, aux premières nuits. La somme des nuits égale donc EXACTEMENT le montant de la réservation
 * (la migration 0019 applique la même règle en SQL ; un test compare les deux).
 */
import { addDays, diffDays, type ISODate } from "../dates";

/** Plafond de nuits par réservation : une date aberrante ne doit pas fabriquer des milliers de lignes. */
export const MAX_NIGHTS = 400;

export type ReservationStatus = "CONFIRMED" | "CANCELLED" | "BLOCKED" | "DUPLICATE";
export type Snap = { status: ReservationStatus; channel: string; checkIn: ISODate; checkOut: ISODate; grossRoomCents: number; cleaningCents: number | null; commissionCents: number | null; paymentFeeCents: number | null };
export type NightRow = { night: ISODate; status: "CONFIRMED" | "BLOCKED"; channel: string; grossRoomCents: number; commissionCents: number | null; paymentFeeCents: number | null };

/** `total` réparti sur `n` nuits, reste sur les premières. n ≤ 0 : aucune nuit. */
export function allocate(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.trunc(total / n), rest = total - base * n; // reste du signe de total ; en pratique total ≥ 0
  return Array.from({ length: n }, (_, i) => base + (i < Math.abs(rest) ? Math.sign(rest) : 0));
}

/** Nuits d'une réservation : aucune si elle est annulée ou doublon (dates rouvertes), ou si ses dates sont incohérentes. */
export function nightsOf(r: Snap): NightRow[] {
  if (r.status !== "CONFIRMED" && r.status !== "BLOCKED") return [];
  const n = diffDays(r.checkOut, r.checkIn);
  if (n < 1 || n > MAX_NIGHTS) return [];
  const gross = allocate(r.grossRoomCents, n), com = r.commissionCents === null ? null : allocate(r.commissionCents, n), fee = r.paymentFeeCents === null ? null : allocate(r.paymentFeeCents, n);
  return gross.map((g, i) => ({ night: addDays(r.checkIn, i), status: r.status as "CONFIRMED" | "BLOCKED", channel: r.channel, grossRoomCents: g, commissionCents: com ? com[i] : null, paymentFeeCents: fee ? fee[i] : null }));
}

export type ChangeKind = "CREATED" | "MODIFIED" | "CANCELLED" | "REACTIVATED" | "UNCHANGED";
export type FieldChange = { key: string; label: string; from: string | null; to: string | null };
const eur = (c: number | null) => (c === null ? null : (c / 100).toFixed(2).replace(".", ",") + " €");
const FIELDS: { key: keyof Snap; label: string; show: (v: any) => string | null }[] = [
  { key: "status", label: "Statut", show: (v) => v ?? null },
  { key: "channel", label: "Canal", show: (v) => v ?? null },
  { key: "checkIn", label: "Arrivée", show: (v) => v ?? null },
  { key: "checkOut", label: "Départ", show: (v) => v ?? null },
  { key: "grossRoomCents", label: "Hébergement", show: eur },
  { key: "cleaningCents", label: "Ménage", show: eur },
  { key: "commissionCents", label: "Commission", show: eur },
  { key: "paymentFeeCents", label: "Frais de paiement", show: eur },
];

/** Ce qui a changé entre deux états, et la nature du changement. `before` null = réservation inconnue jusque-là. */
export function diffReservation(before: Snap | null, after: Snap): { kind: ChangeKind; changes: FieldChange[] } {
  if (!before) return { kind: "CREATED", changes: [] };
  const changes = FIELDS.filter((f) => before[f.key] !== after[f.key]).map((f) => ({ key: f.key, label: f.label, from: f.show(before[f.key]), to: f.show(after[f.key]) }));
  if (changes.length === 0) return { kind: "UNCHANGED", changes };
  const live = (s: ReservationStatus) => s === "CONFIRMED" || s === "BLOCKED";
  if (after.status === "CANCELLED" && before.status !== "CANCELLED") return { kind: "CANCELLED", changes };
  if (before.status === "CANCELLED" && live(after.status)) return { kind: "REACTIVATED", changes };
  return { kind: "MODIFIED", changes };
}

/** Nuits concernées par un changement : de la première arrivée au dernier départ, avant et après. */
export function affectedWindow(before: Pick<Snap, "checkIn" | "checkOut"> | null, after: Pick<Snap, "checkIn" | "checkOut">): { from: ISODate; to: ISODate } {
  const ins = [after.checkIn, ...(before ? [before.checkIn] : [])], outs = [after.checkOut, ...(before ? [before.checkOut] : [])];
  return { from: ins.reduce((a, b) => (a < b ? a : b)), to: outs.reduce((a, b) => (a > b ? a : b)) };
}
