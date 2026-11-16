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

export type ShFeeLine = { type: string; label: string; cents: number; vatRate: number | null };
export type ShReservation = {
  id: string; externalId: string | null; rentalId: string; channel: ShChannel; platformName: string | null; checkIn: ISODate; checkOut: ISODate; nights: number; canceled: boolean;
  /** Montants (centimes), null = non transmis. `total_price` : payé par le voyageur ; `host_payout` : net versé à l'hôte. */
  totalCents: number | null; hostPayoutCents: number | null; cityTaxCents: number | null; cleaningCents: number | null;
  /** Somme des lignes retenues à l'hôte (`host_fees`, en valeur absolue : frais de plateforme + TVA hôte) ; null = lignes absentes de la réponse. */
  hostFeesCents: number | null; feeLines: ShFeeLine[];
};
/** Montant SuperHote en unités majeures (439.6) → centimes ; null si absent ou illisible. */
const cents = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const lines = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/**
 * Total retenu à l'hôte. `host_platform_commission` est le total TTC de la commission : quand il est présent, il est repris SEUL, car SuperHote
 * y ajoute parfois ses composantes (`airbnb_host_fee` + `value_added_tax_host`) et les additionner compterait la commission deux fois
 * (observé sur l'API réelle : 65,84 € = 54,87 € + 10,97 €). Sinon : somme de toutes les lignes.
 */
const totalHostFees = (feeLines: ShFeeLine[]): number => {
  const total = feeLines.filter((l) => l.type === "host_platform_commission");
  return (total.length ? total : feeLines).reduce((a, l) => a + Math.abs(l.cents), 0);
};
export function mapReservation(r: any): ShReservation | null {
  if (r?.id === undefined || r.id === null || !r.checkin || !r.checkout) return null;
  const label = String(r.status_label ?? "").toUpperCase();
  const details = lines(r.price_details), fees = lines(r.host_fees);
  const sumOf = (match: (l: any) => boolean) => (details.some(match) ? details.filter(match).reduce((a, l) => a + (cents(l.total) ?? 0), 0) : null);
  // types observés sur l'API réelle : `cleaning_fee` ; taxe de séjour `guest_exclusive_tax_remitted_by_airbnb` (Airbnb) ou `city_tax` (doc)
  const isCityTax = (l: any) => l?.type === "city_tax" || String(l?.type ?? "").startsWith("guest_exclusive_tax") || /taxe de s[ée]jour/i.test(String(l?.label ?? ""));
  const feeLines: ShFeeLine[] = fees.map((l) => ({ type: String(l?.type ?? ""), label: String(l?.label ?? ""), cents: cents(l?.total) ?? 0, vatRate: Number.isFinite(Number(l?.vat_rate)) && l?.vat_rate !== null && l?.vat_rate !== undefined ? Number(l.vat_rate) : null }));
  return {
    id: String(r.id), externalId: r.external_id !== undefined && r.external_id !== null && r.external_id !== "" ? String(r.external_id) : null, rentalId: String(r.rental_id ?? ""),
    channel: mapPlatform(r.platform_name), platformName: typeof r.platform_name === "string" ? r.platform_name : null,
    checkIn: String(r.checkin).slice(0, 10), checkOut: String(r.checkout).slice(0, 10), nights: Number(r.nights) || 0,
    canceled: !!r.canceled_at || label.startsWith("CANCEL") || label === "NO_SHOW",
    totalCents: cents(r.total_price), hostPayoutCents: cents(r.host_payout), cityTaxCents: sumOf(isCityTax), cleaningCents: sumOf((l) => l?.type === "cleaning_fee"),
    // SuperHote renvoie les lignes `host_fees` en montants POSITIFS (59.52 = frais retenus) ; la valeur absolue couvre aussi un éventuel signe négatif
    hostFeesCents: Array.isArray(r.host_fees) ? totalHostFees(feeLines) : null, feeLines,
  };
}

export type ObservedCommission = { pct: number; n: number; from: ISODate; to: ISODate; excluded: number };
/**
 * Taux de commission réellement retenus par les plateformes, lus chez SuperHote (source de vérité des réservations).
 * Taux = total des lignes `host_fees` ÷ montant payé hors taxe de séjour (la commission ne porte pas sur la taxe de séjour).
 * Les lignes `host_fees` sont explicites (frais de plateforme, TVA hôte) : le versement n'est PAS utilisé comme contrôle, car il retire aussi d'autres montants
 * (sur Booking, environ 1 % de plus que total − taxe − commission). Seul un taux supérieur à `maxPct` (40 %) est jugé invraisemblable : la réservation est écartée et comptée (`excluded`).
 */
export function observedCommission(rows: ShReservation[], maxPct = 40): Partial<Record<"AIRBNB" | "BOOKING", ObservedCommission>> {
  const out: Partial<Record<"AIRBNB" | "BOOKING", ObservedCommission>> = {};
  for (const ch of ["AIRBNB", "BOOKING"] as const) {
    const live = rows.filter((r) => !r.canceled && r.channel === ch && (r.hostFeesCents ?? 0) > 0 && (r.totalCents ?? 0) > 0);
    const ok = live.filter((r) => r.hostFeesCents! / (r.totalCents! - (r.cityTaxCents ?? 0)) <= maxPct / 100 && r.totalCents! - (r.cityTaxCents ?? 0) > 0);
    const base = ok.reduce((a, r) => a + r.totalCents! - (r.cityTaxCents ?? 0), 0);
    if (ok.length === 0 || base <= 0) continue;
    const days = ok.map((r) => r.checkIn).sort();
    out[ch] = { pct: Math.round((ok.reduce((a, r) => a + r.hostFeesCents!, 0) / base) * 1000) / 10, n: ok.length, from: days[0], to: days[days.length - 1], excluded: live.length - ok.length };
  }
  return out;
}

export type ObservedPaymentFee = { pct: number; n: number; from: ISODate; to: ISODate };
/**
 * Frais de paiement Booking.com, déduits de l'écart de versement : total − taxe de séjour − commission − versement hôte, ramené à (total − taxe de séjour).
 * Validé sur l'API réelle (16/11/2026) : 1,40 % sur 12 réservations sur 14, même base que la commission (les 2 autres, 1,57 % et 1,60 %, sont des séjours de février).
 * Un taux fixe de plateforme : on retient la MÉDIANE des taux par réservation, pas une moyenne pondérée qu'un gros séjour atypique tirerait vers le haut. Seuls les écarts positifs entrent dans le calcul.
 */
export function observedPaymentFee(rows: ShReservation[], maxPct = 5): ObservedPaymentFee | null {
  const ok = rows.filter((r) => !r.canceled && r.channel === "BOOKING" && (r.hostFeesCents ?? 0) > 0 && (r.totalCents ?? 0) > 0 && r.hostPayoutCents !== null).map((r) => {
    const base = r.totalCents! - (r.cityTaxCents ?? 0);
    return { r, base, gap: base - r.hostFeesCents! - r.hostPayoutCents! };
  }).filter((x) => x.base > 0 && x.gap > 0 && x.gap / x.base <= maxPct / 100);
  if (ok.length === 0) return null;
  const rates = ok.map((x) => x.gap / x.base).sort((a, b) => a - b), mid = Math.floor(rates.length / 2);
  const median = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  const days = ok.map((x) => x.r.checkIn).sort();
  return { pct: Math.round(median * 1000) / 10, n: ok.length, from: days[0], to: days[days.length - 1] };
}

export type ReservationCheck = { compared: number; onlySuperhote: number; onlyPriceLabs: number; amountDiffs: number; samples: { id: string; shCents: number | null; plCents: number | null; kind: "ABSENTE_PRICELABS" | "ABSENTE_SUPERHOTE" | "MONTANT" }[] };
/**
 * Contrôle croisé SuperHote / PriceLabs sur les réservations non annulées (rapprochées par identifiant).
 * SuperHote fait foi : l'écart est signalé, jamais corrigé. PriceLabs arrondit les montants à l'euro (tolérance 1 €).
 */
export function compareReservations(sh: ShReservation[], plRows: { reservation_id: unknown; booking_status?: unknown; total_cost?: unknown }[], toleranceCents = 100): ReservationCheck {
  const shLive = sh.filter((r) => !r.canceled && (r.totalCents ?? 0) > 0);
  const plLive = plRows.filter((r) => r.reservation_id !== undefined && r.reservation_id !== null && !String(r.booking_status ?? "").toLowerCase().startsWith("cancel") && Number(r.total_cost) > 0);
  const plById = new Map(plLive.map((r) => [String(r.reservation_id), r]));
  const shIds = new Set<string>();
  const out: ReservationCheck = { compared: 0, onlySuperhote: 0, onlyPriceLabs: 0, amountDiffs: 0, samples: [] };
  const sample = (x: ReservationCheck["samples"][number]) => { if (out.samples.length < 5) out.samples.push(x); };
  for (const r of shLive) {
    const m = plById.get(r.id) ?? (r.externalId ? plById.get(r.externalId) : undefined);
    if (m) { shIds.add(String(m.reservation_id)); out.compared++; const pl = Math.round(Number(m.total_cost) * 100); if (Math.abs(pl - r.totalCents!) > toleranceCents) { out.amountDiffs++; sample({ id: r.id, shCents: r.totalCents, plCents: pl, kind: "MONTANT" }); } }
    else { out.onlySuperhote++; sample({ id: r.id, shCents: r.totalCents, plCents: null, kind: "ABSENTE_PRICELABS" }); }
  }
  for (const r of plLive) if (!shIds.has(String(r.reservation_id))) { out.onlyPriceLabs++; sample({ id: String(r.reservation_id), shCents: null, plCents: Math.round(Number(r.total_cost) * 100), kind: "ABSENTE_SUPERHOTE" }); }
  return out;
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
