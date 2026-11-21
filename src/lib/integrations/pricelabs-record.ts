import type { Scenario } from "./pricelabs-scenarios";

/**
 * Rend anonyme un enregistrement de réponses PriceLabs avant de le garder comme fixture. LISTE BLANCHE : seuls les champs connus et utiles
 * aux tests sont conservés (dates, montants, statuts, canaux, bornes de prix) ; tout autre champ, y compris un champ que PriceLabs ajouterait
 * plus tard (nom du logement, téléphone, texte libre…), est supprimé. Noms, identifiants d'annonce et de réservations sont remplacés de façon cohérente.
 */
const LISTING_KEEP = ["pms", "currency", "min", "base", "max", "no_of_bedrooms", "push_enabled", "last_refreshed_at", "last_date_pushed", "city_name"];
const RESA_KEEP = ["pms", "check_in", "check_out", "no_of_days", "booking_status", "booked_date", "booking_channel", "rental_revenue", "total_cost", "ota_commission", "cleaning_fees", "currency"];
const PRICE_ITEM_KEEP = ["pms", "currency", "last_refreshed_at", "error_status"];
const PRICE_DAY_KEEP = ["date", "price", "user_price", "min_stay", "booking_status", "unbookable", "demand_desc"];
const pick = (o: Record<string, any>, keys: string[]) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

export function anonymizeScenario(sc: Scenario): Scenario {
  const ids = new Map<string, string>(), resaIds = new Map<string, string>();
  const idOf = (v: unknown) => { const k = String(v); if (!ids.has(k)) ids.set(k, `fake-${1001 + ids.size}`); return ids.get(k)!; };
  const resaOf = (v: unknown) => { const k = String(v); if (!resaIds.has(k)) resaIds.set(k, `FAKE-R${resaIds.size + 1}`); return resaIds.get(k)!; };
  const out: Scenario = { listings: [], prices: {}, neighborhood: {}, reservations: {} };
  sc.listings.forEach((l, n) => out.listings.push({ id: idOf(l.id), name: `Logement ${n + 1} (enregistrement anonymisé)`, ...pick(l, LISTING_KEEP) }));
  for (const [id, item] of Object.entries(sc.prices)) out.prices[idOf(id)] = item && { id: idOf(id), ...pick(item, PRICE_ITEM_KEEP), ...(Array.isArray(item.data) ? { data: item.data.map((d: any) => pick(d, PRICE_DAY_KEEP)) } : {}) };
  // le marché ne contient que des séries chiffrées par date et le nom de la source des données : conservé tel quel
  for (const [id, m] of Object.entries(sc.neighborhood)) out.neighborhood[idOf(id)] = m;
  for (const [id, rows] of Object.entries(sc.reservations)) out.reservations[idOf(id)] = rows.map((r) => ({ reservation_id: resaOf(r.reservation_id), listing_id: idOf(id), ...pick(r, RESA_KEEP) }));
  return out;
}
