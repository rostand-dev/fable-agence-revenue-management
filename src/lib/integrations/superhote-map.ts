/**
 * Traduction des réponses de l'API publique SuperHote v2 (https://docs.superhote.com/api-v2/), fonctions pures et testables.
 *
 * Points documentés : enveloppe `{ success, result }` avec `meta` DANS `result` ; prix de calendrier par nuit (nombre, 135.5 = euros) ;
 * réservations avec `platform_name`, `status_label`, `checkin`, `checkout`.
 * Point NON documenté : la clé exacte du tableau dans `result` (la doc dit seulement qu'il n'y a pas de clé `data`).
 * `listOf` reste donc tolérante, et un écart de forme est signalé en clair plutôt que deviné.
 */
import type { ISODate } from "../dates";

export class ShapeError extends Error {}

export const unwrap = (j: any): any => (j && typeof j === "object" && "result" in j ? j.result : j);

const LIST_KEYS = ["items", "rentals", "reservations", "calendar", "days", "results", "records", "list"];
/** Extrait le tableau d'éléments d'une réponse : tableau direct, clé connue, ou unique propriété tableau. */
export function listOf(result: any): any[] {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== "object") throw new ShapeError("Réponse SuperHote vide ou inattendue.");
  for (const k of LIST_KEYS) if (Array.isArray(result[k])) return result[k];
  const arrays = Object.entries(result).filter(([k, v]) => k !== "meta" && Array.isArray(v));
  if (arrays.length === 1) return arrays[0][1] as any[];
  throw new ShapeError("La forme de la réponse SuperHote n'est pas celle attendue (aucun tableau d'éléments reconnu).");
}
export const lastPage = (j: any): number => {
  const m = unwrap(j)?.meta ?? j?.meta;
  const n = Number(m?.last_page);
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

export type ShRental = { id: string; name: string; city: string | null; capacity: number | null; currency: string | null; enabled: boolean };
export function mapRental(r: any): ShRental | null {
  if (r?.id === undefined || r.id === null || !r.name) return null;
  return { id: String(r.id), name: String(r.name), city: typeof r.city === "string" ? r.city : null, capacity: Number.isFinite(Number(r.capacity)) ? Number(r.capacity) : null, currency: typeof r.currency === "string" ? r.currency : null, enabled: r.enabled !== false };
}

export type ShChannel = "AIRBNB" | "BOOKING" | "DIRECT" | null;
/** Plateforme SuperHote → canal NuitSignal. Un nom inconnu reste inconnu (null) : on ne devine pas. */
export function mapPlatform(name: unknown): ShChannel {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!n) return null;
  if (n.includes("airbnb")) return "AIRBNB";
  if (n.includes("booking")) return "BOOKING";
  if (/^(direct|manual|manuel|site|website)/.test(n)) return "DIRECT";
  return null;
}

export type ShReservation = { id: string; externalId: string | null; rentalId: string; channel: ShChannel; platformName: string | null; checkIn: ISODate; checkOut: ISODate; nights: number; canceled: boolean };
export function mapReservation(r: any): ShReservation | null {
  if (r?.id === undefined || r.id === null || !r.checkin || !r.checkout) return null;
  const label = String(r.status_label ?? "").toUpperCase();
  return {
    id: String(r.id), externalId: r.external_id !== undefined && r.external_id !== null && r.external_id !== "" ? String(r.external_id) : null, rentalId: String(r.rental_id ?? ""),
    channel: mapPlatform(r.platform_name), platformName: typeof r.platform_name === "string" ? r.platform_name : null,
    checkIn: String(r.checkin).slice(0, 10), checkOut: String(r.checkout).slice(0, 10), nights: Number(r.nights) || 0,
    canceled: !!r.canceled_at || label.startsWith("CANCEL") || label === "NO_SHOW",
  };
}

export type ShNight = { date: ISODate; available: boolean; priceCents: number | null; reservationId: string | null };
/** Prix de calendrier : unités majeures (exemple documenté 135.5), converti en centimes. null = pas de prix. */
export function mapCalendar(rows: any[]): ShNight[] {
  const out: ShNight[] = [];
  for (const n of rows ?? []) {
    if (!n?.date) continue;
    const p = n.price === null || n.price === undefined ? null : Number(n.price);
    out.push({ date: String(n.date).slice(0, 10), available: n.available !== false, priceCents: p !== null && Number.isFinite(p) ? Math.round(p * 100) : null, reservationId: n.reservation_id ? String(n.reservation_id) : null });
  }
  return out;
}

/**
 * Canal à appliquer aux réservations que PriceLabs a transmises sans canal.
 * Rapprochement par identifiant (id ou external_id SuperHote = reservation_id PriceLabs), sinon par dates exactes
 * d'arrivée et de départ, à condition qu'une seule réservation SuperHote corresponde. Une ambiguïté n'est jamais tranchée.
 */
export function channelHints(plRows: { reservation_id: unknown; check_in: unknown; check_out: unknown; booking_channel?: unknown }[], sh: ShReservation[], hasChannel: (c: unknown) => boolean): Record<string, "AIRBNB" | "BOOKING" | "DIRECT"> {
  const live = sh.filter((r) => !r.canceled && r.channel);
  const byId = new Map<string, ShReservation>();
  for (const r of live) { byId.set(r.id, r); if (r.externalId) byId.set(r.externalId, r); }
  const byDates = new Map<string, ShReservation[]>();
  for (const r of live) { const k = r.checkIn + "|" + r.checkOut; byDates.set(k, [...(byDates.get(k) ?? []), r]); }
  const out: Record<string, "AIRBNB" | "BOOKING" | "DIRECT"> = {};
  for (const row of plRows) {
    if (hasChannel(row.booking_channel) || row.reservation_id === undefined || row.reservation_id === null) continue;
    const id = String(row.reservation_id);
    let m = byId.get(id);
    if (!m) { const c = byDates.get(String(row.check_in).slice(0, 10) + "|" + String(row.check_out).slice(0, 10)); if (c?.length === 1) m = c[0]; }
    if (m?.channel) out[id] = m.channel;
  }
  return out;
}

export type PriceCheckSummary = { compared: number; matching: number; differing: number; maxGapCents: number; medianGapCents: number | null; verdict: "IDENTIQUE" | "ECART" | "INCONNU"; samples: { date: ISODate; shCents: number; sentCents: number }[] };
/**
 * Compare le prix de calendrier SuperHote au `user_price` PriceLabs (prix envoyé à SuperHote), sur les nuits libres.
 * Si les deux sont identiques, le prix du calendrier SuperHote est le prix AVANT majoration par canal.
 */
export function comparePriceSeries(sh: ShNight[], sent: { date: ISODate; sentPriceCents: number | null; state: string }[], toleranceCents = 100): PriceCheckSummary {
  const by = new Map(sh.map((n) => [n.date, n]));
  const gaps: number[] = [], samples: PriceCheckSummary["samples"] = [];
  let matching = 0, differing = 0;
  for (const d of sent) {
    const n = by.get(d.date);
    if (!n || d.state !== "FREE" || !n.available || n.reservationId || n.priceCents === null || typeof d.sentPriceCents !== "number" || d.sentPriceCents <= 0) continue;
    const gap = n.priceCents - d.sentPriceCents;
    gaps.push(gap);
    if (Math.abs(gap) <= toleranceCents) matching++; else { differing++; if (samples.length < 5) samples.push({ date: d.date, shCents: n.priceCents, sentCents: d.sentPriceCents }); }
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const verdict = gaps.length === 0 ? "INCONNU" : differing === 0 ? "IDENTIQUE" : "ECART";
  return { compared: gaps.length, matching, differing, maxGapCents: gaps.reduce((a, g) => Math.max(a, Math.abs(g)), 0), medianGapCents: median, verdict, samples };
}
