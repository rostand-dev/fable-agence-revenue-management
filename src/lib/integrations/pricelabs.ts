import { addDays, type ISODate } from "../dates";
import { mapListing, type PlListing } from "./pricelabs-map";

/** Client de l'API client PriceLabs (https://api.pricelabs.co/v1), en lecture seule. */
export class PriceLabsError extends Error {
  constructor(message: string, public status: number | null = null) { super(message); }
}
const base = () => (process.env.PRICELABS_API_BASE || "https://api.pricelabs.co/v1").replace(/\/$/, "");

async function call(apiKey: string, path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<any> {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 45000);
  let res: Response;
  try {
    res = await fetch(base() + path, { method: init.method ?? "GET", signal: ctrl.signal, cache: "no-store", headers: { "X-API-Key": apiKey, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
  } catch (e: any) {
    throw new PriceLabsError(e?.name === "AbortError" ? "PriceLabs n'a pas répondu à temps." : "PriceLabs est injoignable depuis le serveur.");
  } finally { clearTimeout(timer); }
  if (res.status === 401) throw new PriceLabsError("Clé API refusée par PriceLabs. Vérifiez qu'elle est copiée en entier et que l'API est activée.", 401);
  if (res.status === 403) throw new PriceLabsError("Accès refusé par PriceLabs : l'API n'est pas activée sur ce compte, ou la clé est celle d'un sous-utilisateur.", 403);
  if (res.status === 429) throw new PriceLabsError("Trop de requêtes vers PriceLabs. Réessayez dans quelques minutes.", 429);
  if (!res.ok) throw new PriceLabsError(`PriceLabs a répondu par une erreur (HTTP ${res.status}).`, res.status);
  try { return await res.json(); } catch { throw new PriceLabsError("Réponse PriceLabs illisible."); }
}

export async function listListings(apiKey: string): Promise<PlListing[]> {
  const j = await call(apiKey, "/listings");
  return (Array.isArray(j?.listings) ? j.listings : []).filter((l: any) => l?.id && l?.pms).map(mapListing);
}
export async function getPrices(apiKey: string, id: string, pms: string, from: ISODate, to: ISODate): Promise<any> {
  const j = await call(apiKey, "/listing_prices", { method: "POST", body: { listings: [{ id, pms, dateFrom: from, dateTo: to }] } });
  const item = Array.isArray(j) ? j.find((x) => String(x?.id) === id) ?? j[0] : null;
  if (!item) throw new PriceLabsError("PriceLabs n'a renvoyé aucune grille pour ce logement.");
  if (item.error || item.error_status) throw new PriceLabsError(item.error_status === "LISTING_TOGGLE_OFF" ? "La synchronisation de ce logement est désactivée dans PriceLabs : aucun prix n'est disponible par l'API." : `PriceLabs ne fournit pas de prix pour ce logement (${item.error_status ?? item.error}).`);
  return item;
}
export async function getNeighborhood(apiKey: string, id: string, pms: string): Promise<any> {
  const j = await call(apiKey, `/neighborhood_data?listing_id=${encodeURIComponent(id)}&pms=${encodeURIComponent(pms)}`, { timeoutMs: 60000 });
  return j?.data ?? null;
}
/** Réservations par date d'arrivée, toutes pages (borne de sécurité : 30 pages de 100). */
export async function getReservations(apiKey: string, id: string, pms: string, from: ISODate, to: ISODate): Promise<any[]> {
  const rows: any[] = [];
  for (let page = 0; page < 30; page++) {
    const j = await call(apiKey, `/reservation_data?pms=${encodeURIComponent(pms)}&listing_id=${encodeURIComponent(id)}&start_date=${from}&end_date=${to}&limit=100&offset=${page * 100}`);
    rows.push(...(Array.isArray(j?.data) ? j.data : []));
    if (!j?.next_page) break;
  }
  return rows;
}
export const horizon = (today: ISODate) => ({ from: today, to: addDays(today, 90), histFrom: addDays(today, -365), histTo: addDays(today, 366) });
