import type { Scenario } from "./pricelabs-scenarios";

/**
 * Rend anonyme un enregistrement de réponses PriceLabs avant de le garder comme fixture : noms, groupes, étiquettes, notes,
 * identifiants d'annonce et de réservations sont remplacés (de façon cohérente d'une réponse à l'autre). Dates et montants sont conservés :
 * ce sont eux que les tests rejouent.
 */
const DROP = ["group", "subgroup", "tags", "notes", "latitude", "longitude", "address", "state", "country"];

export function anonymizeScenario(sc: Scenario): Scenario {
  const ids = new Map<string, string>();
  const idOf = (v: unknown) => { const k = String(v); if (!ids.has(k)) ids.set(k, `fake-${1001 + ids.size}`); return ids.get(k)!; };
  const resaIds = new Map<string, string>();
  const resaOf = (v: unknown) => { const k = String(v); if (!resaIds.has(k)) resaIds.set(k, `FAKE-R${resaIds.size + 1}`); return resaIds.get(k)!; };
  const out: Scenario = { listings: [], prices: {}, neighborhood: {}, reservations: {} };
  sc.listings.forEach((l, n) => {
    const copy: Record<string, unknown> = { ...l, id: idOf(l.id), name: `Logement ${n + 1} (enregistrement anonymisé)` };
    for (const k of DROP) delete copy[k];
    out.listings.push(copy);
  });
  for (const [id, item] of Object.entries(sc.prices)) out.prices[idOf(id)] = item && { ...item, id: idOf(id) };
  for (const [id, n] of Object.entries(sc.neighborhood)) out.neighborhood[idOf(id)] = n;
  for (const [id, rows] of Object.entries(sc.reservations)) out.reservations[idOf(id)] = rows.map((r) => ({ ...r, reservation_id: resaOf(r.reservation_id), listing_id: idOf(id), guest_name: undefined, guest_email: undefined }));
  return out;
}
