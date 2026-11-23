import { addDays, dow, type ISODate } from "../dates";

/**
 * Jeux de données synthétiques de PriceLabs (US-044), dans la forme exacte des réponses de l'API client.
 * Déterministes : le même nom et la même date donnent toujours le même jeu (aucun hasard, aucune horloge).
 * Servent au faux adaptateur en mémoire, au serveur HTTP factice (tests E2E) et à la fixture rejouée.
 * Aucune donnée réelle : un logement fictif, deux réservations à venir, une passée, une annulée.
 */
/** `write` : toutes les écritures (min/base/max et prix datés), épic 9. */
export type Endpoint = "listings" | "prices" | "neighborhood" | "reservations" | "write";
export type Scenario = {
  /** Réponse `/listings` : annonces du compte. */
  listings: any[];
  /** Par identifiant d'annonce : élément de `/listing_prices` (ou `{ id, pms, error_status }`). */
  prices: Record<string, any>;
  /** Par identifiant d'annonce : `data` de `/neighborhood_data`, ou null. */
  neighborhood: Record<string, any | null>;
  /** Par identifiant d'annonce : lignes de `/reservation_data`. */
  reservations: Record<string, any[]>;
  /** Point d'accès → statut HTTP d'échec renvoyé à chaque appel. */
  failures?: Partial<Record<Endpoint, number>>;
  /** Point d'accès → panne passagère : les `times` premiers appels échouent, les suivants réussissent. */
  flaky?: Partial<Record<Endpoint, { status: number; times: number }>>;
};

export const SCENARIO_NAMES = ["nominal", "toggle-off", "market-down", "market-sparse", "unauthorized", "forbidden", "rate-limited", "partial-grid", "min-above-base", "two-listings", "flaky", "write-forbidden", "write-down", "write-flaky"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];
export const isScenarioName = (v: unknown): v is ScenarioName => typeof v === "string" && (SCENARIO_NAMES as readonly string[]).includes(v);

export const FAKE_LISTING_ID = "fake-1001";
export const FAKE_SECOND_LISTING_ID = "fake-1002";
const PMS = "superhote";

const DEFAULT_LISTING = { id: FAKE_LISTING_ID, pms: PMS, name: "Châtillon (jeu fictif)", city_name: "Châtillon", no_of_bedrooms: 2, currency: "EUR", min: 83, base: 116, max: 250, push_enabled: true, last_refreshed_at: "" };

/** Séjours du jeu : [décalage d'arrivée, nuits, canal, statut]. Négatif = passé. Les nuits des séjours à venir sont « réservées » dans la grille. */
const STAYS: [number, number, string, string][] = [[-30, 4, "airbnb", "booked"], [-12, 3, "bcom", "canceled"], [3, 3, "airbnb", "booked"], [20, 6, "bcom", "booked"]];

function priceOf(base: number, min: number, i: number, d: ISODate): number {
  const weekend = [5, 6].includes(dow(d));
  const wave = 1 + 0.08 * Math.sin(i / 9);
  return Math.max(min, Math.round(base * (weekend ? 1.12 : 1) * wave));
}

function reservationRows(listingId: string, today: ISODate): any[] {
  return STAYS.map(([off, nights, channel, status], n) => {
    const ci = addDays(today, off), total = 118 * nights;
    return {
      reservation_id: `FAKE-R${n + 1}`, listing_id: listingId, pms: PMS, check_in: ci, check_out: addDays(ci, nights), no_of_days: nights, booking_status: status,
      booked_date: addDays(ci, -21) + "T10:00:00.000Z", booking_channel: channel, rental_revenue: "NA", total_cost: String(total), ota_commission: channel === "bcom" ? String(Math.round(total * 0.16)) : "0.0", cleaning_fees: "60.0",
    };
  });
}

function priceItem(listing: any, today: ISODate, days = 91, mutate?: (d: any, i: number) => any): any {
  const booked = new Set<string>(), blocked = new Set<string>([addDays(today, 12), addDays(today, 13)]);
  for (const [off, nights, , status] of STAYS) if (status === "booked" && off >= 0) for (let k = 0; k < nights; k++) booked.add(addDays(today, off + k));
  const data = Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i), price = priceOf(listing.base, listing.min, i, date), isBooked = booked.has(date), isBlocked = blocked.has(date);
    const row = { date, price, user_price: isBooked || isBlocked ? -1 : price + 2, min_stay: [5, 6].includes(dow(date)) ? 3 : 2, booking_status: isBooked ? "Booked" : "", unbookable: isBlocked ? 1 : 0, demand_desc: isBooked || isBlocked ? "Unavailable" : i % 7 === 0 ? "High Demand" : "Normal Demand" };
    return mutate ? mutate(row, i) : row;
  });
  return { id: listing.id, pms: listing.pms, currency: listing.currency, last_refreshed_at: listing.last_refreshed_at, data };
}

function neighborhood(listing: any, today: ISODate, opts: { sparse?: boolean } = {}): any {
  const dates = Array.from({ length: 91 }, (_, i) => addDays(today, i));
  const prices = dates.map((d, i) => priceOf(listing.base, listing.min, i, d));
  const occ = dates.map((d, i) => Math.round((55 + 15 * Math.sin(i / 11) + ([5, 6].includes(dow(d)) ? 8 : 0)) * 10) / 10);
  const category = String(listing.no_of_bedrooms ?? 2);
  const meta = { "Listings Used": opts.sparse ? 3 : 120, "Neighborhood Data Source": "Nearby Listings" };
  const occBlock = { Labels: ["Occupancy", "New Bookings"], Category: { [category]: { X_values: dates, Y_values: [[occ], [dates.map((_, i) => i % 4)]] }, "-1": { X_values: [], Y_values: [] } } };
  if (opts.sparse) return { ...meta, "Future Occ/New/Canc": occBlock };
  const q = (f: number) => prices.map((p) => Math.round(p * f * 10) / 10);
  return { ...meta, "Future Percentile Prices": { Labels: ["25th Percentile", "50th Percentile", "75th Percentile", "Median Booked Price", "90th Percentile", "N_Bookings"], Category: { [category]: { X_values: dates, Y_values: [q(0.85), q(1.05), q(1.3), q(1.02), q(1.9), dates.map(() => 30)] } } }, "Future Occ/New/Canc": occBlock };
}

/**
 * Jeu de données complet pour un scénario nommé, à la date `today` (la grille couvre D+0 à D+90).
 * `idSuffix` rend les identifiants d'annonce uniques (fake-1001-<suffixe>) : le faux serveur l'utilise pour que deux clés différentes
 * désignent deux annonces différentes, car NuitSignal refuse qu'une même annonce alimente deux logements d'un même espace.
 */
export function buildScenario(name: ScenarioName, today: ISODate, opts: { idSuffix?: string } = {}): Scenario {
  const stamp = today + "T04:00:00Z", sfx = opts.idSuffix ? `-${opts.idSuffix}` : "";
  const listing = { ...DEFAULT_LISTING, id: FAKE_LISTING_ID + sfx, last_refreshed_at: stamp, ...(name === "min-above-base" ? { min: 140 } : {}) };
  const second = { ...DEFAULT_LISTING, id: FAKE_SECOND_LISTING_ID + sfx, name: "Évry (jeu fictif)", city_name: "Évry-Courcouronnes", no_of_bedrooms: 4, min: 120, base: 163, max: 320, last_refreshed_at: stamp };
  const listings = name === "two-listings" ? [listing, second] : [listing];
  const sc: Scenario = { listings: [], prices: {}, neighborhood: {}, reservations: {} };
  for (const l of listings) {
    sc.listings.push(l);
    sc.prices[l.id] = priceItem(l, today);
    sc.neighborhood[l.id] = neighborhood(l, today);
    sc.reservations[l.id] = reservationRows(l.id, today);
  }
  const id = listing.id;
  switch (name) {
    case "toggle-off": sc.prices[id] = { id, pms: PMS, error_status: "LISTING_TOGGLE_OFF" }; break;
    case "market-down": sc.failures = { neighborhood: 500 }; break;
    case "market-sparse": sc.neighborhood[id] = neighborhood(listing, today, { sparse: true }); break;
    case "unauthorized": sc.failures = { listings: 401, prices: 401, neighborhood: 401, reservations: 401 }; break;
    case "forbidden": sc.failures = { listings: 403, prices: 403, neighborhood: 403, reservations: 403 }; break;
    case "rate-limited": sc.failures = { listings: 429, prices: 429, neighborhood: 429, reservations: 429 }; break;
    // 60 jours seulement, et un prix absent toutes les dix nuits : PriceLabs n'a pas fini de calculer la grille
    case "partial-grid": sc.prices[id] = priceItem(listing, today, 60, (row, i) => (i % 10 === 4 ? { ...row, price: "NA", user_price: "NA" } : row)); break;
    // épic 9 : la lecture est nominale, l'écriture est refusée (clé sans droit), en panne, ou tombe en 429 une fois puis réussit (rejeu)
    case "write-forbidden": sc.failures = { write: 403 }; break;
    case "write-down": sc.failures = { write: 500 }; break;
    case "write-flaky": sc.flaky = { write: { status: 429, times: 1 } }; break;
    case "flaky": sc.flaky = { listings: { status: 503, times: 1 }, prices: { status: 503, times: 1 } }; break;
    default: break;
  }
  return sc;
}
