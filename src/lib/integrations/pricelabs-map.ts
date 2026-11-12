import type { ISODate } from "../dates";
import type { EconomicModel } from "../engine/types";

/**
 * Traduction des réponses de l'API client PriceLabs vers le modèle interne.
 * Fonctions pures, testées sur des réponses de la forme réellement renvoyée par l'API.
 * Règle : une valeur absente, « NA », −1 ou non numérique devient null (inconnue), jamais zéro.
 */
export type PlListing = { id: string; pms: string; name: string; city: string | null; bedrooms: number | null; currency: string | null; minCents: number | null; baseCents: number | null; maxCents: number | null; pushEnabled: boolean | null; lastRefreshedAt: string | null };
export type PlDay = { date: ISODate; state: "FREE" | "BOOKED" | "BLOCKED"; priceCents: number | null; minStay: number | null; rule: string | null };
export type PlMarketDay = { date: ISODate; marketOccupancy: number | null; marketAdrCents: number | null; pricePercentile: number | null; event: string | null };
export type PlReservation = { externalId: string; channel: string; checkIn: ISODate; checkOut: ISODate; nights: number; grossRoomCents: number; cleaningCents: number | null; commissionCents: number | null; paymentFeeCents: number | null; status: "CONFIRMED" | "CANCELLED" | "BLOCKED" | "DUPLICATE"; bookedAt: ISODate; commissionEstimated: boolean };

const num = (v: unknown): number | null => { if (v === null || v === undefined || v === "" || v === "NA") return null; const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? n : null; };
const pos = (v: unknown): number | null => { const n = num(v); return n !== null && n > 0 ? n : null; };
const cents = (v: number | null) => (v === null ? null : Math.round(v * 100));

export function mapListing(l: any): PlListing {
  return {
    id: String(l.id), pms: String(l.pms), name: String(l.name ?? l.id), city: l.city_name ?? null, bedrooms: num(l.no_of_bedrooms), currency: l.currency ?? null,
    minCents: cents(pos(l.min)), baseCents: cents(pos(l.base)), maxCents: cents(pos(l.max)), pushEnabled: typeof l.push_enabled === "boolean" ? l.push_enabled : null, lastRefreshedAt: l.last_refreshed_at ?? null,
  };
}

/** Grille : `user_price` est le prix publié ; il vaut −1 sur une nuit réservée ou bloquée. */
export function mapPrices(item: any): PlDay[] {
  if (!item || !Array.isArray(item.data)) return [];
  return item.data.filter((d: any) => typeof d?.date === "string").map((d: any) => {
    const booked = typeof d.booking_status === "string" && d.booking_status.trim() !== "";
    const state: PlDay["state"] = booked ? "BOOKED" : num(d.unbookable) === 1 ? "BLOCKED" : "FREE";
    const demand = typeof d.demand_desc === "string" && d.demand_desc !== "Unavailable" ? d.demand_desc : null;
    return { date: d.date.slice(0, 10), state, priceCents: cents(pos(d.user_price) ?? (state === "FREE" ? pos(d.price) : null)), minStay: pos(d.min_stay), rule: demand };
  });
}

/** Position d'un prix entre les centiles 25/50/75/90 du marché, par interpolation linéaire. */
export function percentileOf(price: number, p25: number | null, p50: number | null, p75: number | null, p90: number | null): number | null {
  const pts: [number, number][] = [[25, p25], [50, p50], [75, p75], [90, p90]].filter((x): x is [number, number] => x[1] !== null && (x[1] as number) > 0) as any;
  if (pts.length < 2) return null;
  if (price <= pts[0][1]) return Math.max(1, Math.round(pts[0][0] * price / pts[0][1]));
  for (let i = 1; i < pts.length; i++) {
    const [qa, va] = pts[i - 1], [qb, vb] = pts[i];
    if (price <= vb) return Math.round(vb === va ? qb : qa + (qb - qa) * (price - va) / (vb - va));
  }
  const [ql, vl] = pts[pts.length - 1];
  return Math.min(99, Math.round(ql + (99 - ql) * Math.min(1, (price - vl) / vl)));
}

function series(block: any, category: string, label: string): Map<string, number> {
  const out = new Map<string, number>();
  const cat = block?.Category?.[category], li = (block?.Labels ?? []).indexOf(label);
  if (!cat || li < 0 || !Array.isArray(cat.X_values)) return out;
  let row = cat.Y_values?.[li];
  // « Future Occ/New/Canc » enveloppe chaque ligne dans un tableau supplémentaire : [[v1, v2, …]]
  while (Array.isArray(row) && row.length === 1 && Array.isArray(row[0])) row = row[0];
  if (!Array.isArray(row)) return out;
  cat.X_values.forEach((x: any, i: number) => { const v = num(row[i]); if (typeof x === "string" && v !== null) out.set(x.slice(0, 10), v); });
  return out;
}
export function pickCategory(data: any, bedrooms: number | null): string | null {
  const keys = Object.keys(data?.["Future Occ/New/Canc"]?.Category ?? data?.["Future Percentile Prices"]?.Category ?? {});
  if (!keys.length) return null;
  const want = bedrooms === null ? null : String(Math.round(bedrooms));
  return want && keys.includes(want) ? want : keys.find((k) => k !== "-1") ?? keys[0];
}

/** Marché : occupation (renvoyée en pourcentage 0–100) et centiles de prix, indexés par date et non par position. */
export function mapMarket(data: any, bedrooms: number | null, days: PlDay[]): { market: PlMarketDay[]; category: string | null; listingsUsed: number | null; source: string | null } {
  const category = pickCategory(data, bedrooms);
  const meta = { category, listingsUsed: num(data?.["Listings Used"]), source: typeof data?.["Neighborhood Data Source"] === "string" ? data["Neighborhood Data Source"] : null };
  if (!category) return { market: days.map((d) => ({ date: d.date, marketOccupancy: null, marketAdrCents: null, pricePercentile: null, event: null })), ...meta };
  const occ = series(data["Future Occ/New/Canc"], category, "Occupancy");
  const P = (l: string) => series(data["Future Percentile Prices"], category, l);
  const p25 = P("25th Percentile"), p50 = P("50th Percentile"), p75 = P("75th Percentile"), p90 = P("90th Percentile"), booked = P("Median Booked Price");
  const market = days.map((d) => {
    const o = occ.get(d.date), g = (m: Map<string, number>) => m.get(d.date) ?? null;
    const adr = g(booked) ?? g(p50);
    return {
      date: d.date, marketOccupancy: o === undefined ? null : Math.round(Math.min(100, Math.max(0, o))) / 100, marketAdrCents: cents(adr),
      pricePercentile: d.priceCents === null ? null : percentileOf(d.priceCents / 100, g(p25), g(p50), g(p75), g(p90)), event: null,
    };
  });
  return { market, ...meta };
}

const CHANNEL: Record<string, string> = { manual: "MANUEL", airbnb: "AIRBNB", bcom: "BOOKING", booking: "BOOKING", "booking.com": "BOOKING", bookingcom: "BOOKING" };
export const mapChannel = (c: unknown) => (typeof c === "string" && c.trim() ? CHANNEL[c.trim().toLowerCase()] ?? c.trim().toUpperCase().slice(0, 24) : "INCONNU");

/**
 * Réservations du PMS relayées par PriceLabs. Montant = `rental_revenue` s'il est fourni, sinon `total_cost`.
 * Une réservation confirmée à 0 € est un blocage propriétaire. Quand le PMS ne fournit pas la commission,
 * elle est estimée avec le taux déclaré du canal et signalée comme telle ; sans taux déclaré, elle reste inconnue.
 */
export type ChannelOverride = "AIRBNB" | "BOOKING" | "DIRECT" | "EXCLUDE";

export function mapReservations(rows: any[], model: EconomicModel | null, overrides: Record<string, ChannelOverride> = {}): PlReservation[] {
  const out: PlReservation[] = [];
  for (const r of rows ?? []) {
    if (!r?.reservation_id || !r.check_in || !r.check_out) continue;
    const st = String(r.booking_status ?? "").toLowerCase();
    if (st === "available") continue;
    const gross = num(r.rental_revenue) ?? num(r.total_cost) ?? 0;
    // canal précisé par le propriétaire pour une réservation que le PMS a transmise sans canal
    const ov = overrides[String(r.reservation_id)];
    const raw = mapChannel(r.booking_channel);
    const channel = raw === "INCONNU" && ov && ov !== "EXCLUDE" ? ov : raw;
    const cancelled = st.startsWith("cancel");
    const status: PlReservation["status"] = cancelled ? "CANCELLED" : st === "blocked" || gross <= 0 ? "BLOCKED" : raw === "INCONNU" && ov === "EXCLUDE" ? "DUPLICATE" : "CONFIRMED";
    const rate = model?.channels?.[channel as "AIRBNB" | "BOOKING"];
    const given = pos(r.ota_commission);
    const grossCents = Math.round(gross * 100);
    out.push({
      externalId: String(r.reservation_id), channel, checkIn: String(r.check_in).slice(0, 10), checkOut: String(r.check_out).slice(0, 10),
      nights: num(r.no_of_days) ?? 0, grossRoomCents: grossCents, cleaningCents: cents(pos(r.cleaning_fees)),
      // une réservation en direct ne supporte aucune commission de plateforme
      commissionCents: given !== null ? Math.round(given * 100) : channel === "DIRECT" ? 0 : rate ? Math.round(grossCents * rate.commissionPct / 100) : null,
      paymentFeeCents: channel === "DIRECT" ? 0 : rate ? Math.round(grossCents * rate.paymentFeePct / 100) : null,
      status, bookedAt: String(r.booked_date ?? r.check_in).slice(0, 10), commissionEstimated: given === null && !!rate,
    });
  }
  return dedupeConfirmed(out);
}

/**
 * Un logement ne peut pas être réservé deux fois la même nuit. Quand deux réservations confirmées se chevauchent,
 * l'une est un reliquat (migration ou modification dans le PMS) : elle est marquée DUPLICATE et sort des calculs,
 * sans être supprimée. On garde celle dont le canal est identifié ; à défaut, la plus récemment réservée.
 */
export function dedupeConfirmed(rows: PlReservation[]): PlReservation[] {
  const live = rows.filter((r) => r.status === "CONFIRMED").sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  const known = (r: PlReservation) => r.channel !== "INCONNU";
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j];
    if (a.status !== "CONFIRMED" || b.status !== "CONFIRMED") continue;
    if (b.checkIn >= a.checkOut) break;
    if (!(a.checkIn < b.checkOut && b.checkIn < a.checkOut)) continue;
    const loser = known(a) !== known(b) ? (known(a) ? b : a) : a.bookedAt <= b.bookedAt ? a : b;
    loser.status = "DUPLICATE";
    if (loser === a) break;
  }
  return rows;
}
