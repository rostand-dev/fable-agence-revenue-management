import { addDays, type ISODate } from "../dates";
import { mapListing, type PlListing } from "./pricelabs-map";
import type { PriceLabsPort, PriceLabsPortFactory } from "./pricelabs-port";

/** Client de l'API client PriceLabs (https://api.pricelabs.co/v1), en lecture seule. */
export class PriceLabsError extends Error {
  constructor(message: string, public status: number | null = null) { super(message); }
}
const DEFAULT_BASE = "https://api.pricelabs.co/v1";
/**
 * Adresse de l'API. PRICELABS_API_BASE ne peut désigner que la machine locale (faux serveur de test) : la clé API de chaque propriétaire
 * est envoyée à cette adresse, une valeur posée par erreur sur un serveur ne doit pas pouvoir l'exfiltrer. Toute autre valeur est ignorée.
 */
export function apiBase(env: string | undefined = process.env.PRICELABS_API_BASE): string {
  const v = (env ?? "").trim().replace(/\/$/, "");
  if (!v) return DEFAULT_BASE;
  try { const u = new URL(v); if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")) return v; } catch { /* adresse illisible : ignorée */ }
  if (v !== DEFAULT_BASE) console.warn("[pricelabs] PRICELABS_API_BASE ignorée : seule une adresse locale (http://127.0.0.1…) est acceptée.");
  return DEFAULT_BASE;
}
const base = () => apiBase();

/** Erreur lisible pour un statut HTTP d'échec ; partagée avec le faux adaptateur pour que les deux disent la même chose. */
export function errorForStatus(status: number): PriceLabsError {
  if (status === 401) return new PriceLabsError("Clé API refusée par PriceLabs. Vérifiez qu'elle est copiée en entier et que l'API est activée.", 401);
  if (status === 403) return new PriceLabsError("Accès refusé par PriceLabs : l'API n'est pas activée sur ce compte, ou la clé est celle d'un sous-utilisateur.", 403);
  if (status === 429) return new PriceLabsError("Trop de requêtes vers PriceLabs. Réessayez dans quelques minutes.", 429);
  return new PriceLabsError(`PriceLabs a répondu par une erreur (HTTP ${status}).`, status);
}

/** Annonces d'une réponse `/listings` (celles sans identifiant ou sans PMS sont inutilisables et écartées). */
export const unwrapListings = (j: any): PlListing[] => (Array.isArray(j?.listings) ? j.listings : []).filter((l: any) => l?.id && l?.pms).map(mapListing);

/** Élément d'une réponse `/listing_prices` pour l'annonce demandée ; lève une erreur lisible si PriceLabs n'a pas de grille à donner. */
export function unwrapPriceItem(j: any, id: string): any {
  const item = Array.isArray(j) ? j.find((x) => String(x?.id) === id) ?? j[0] : null;
  if (!item) throw new PriceLabsError("PriceLabs n'a renvoyé aucune grille pour ce logement.");
  if (item.error || item.error_status) throw new PriceLabsError(item.error_status === "LISTING_TOGGLE_OFF" ? "La synchronisation de ce logement est désactivée dans PriceLabs : aucun prix n'est disponible par l'API." : `PriceLabs ne fournit pas de prix pour ce logement (${item.error_status ?? item.error}).`);
  return item;
}

/** Observation brute d'un appel, pour l'enregistreur de réponses (jamais utilisée en production). */
export type HttpTap = (endpoint: "listings" | "prices" | "neighborhood" | "reservations", request: Record<string, unknown>, raw: unknown) => void;

export class HttpPriceLabs implements PriceLabsPort {
  readonly adapter = "HTTP" as const;
  constructor(private apiKey: string, private tap?: HttpTap) {}

  private async call(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<any> {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 45000);
    let res: Response;
    try {
      res = await fetch(base() + path, { method: init.method ?? "GET", signal: ctrl.signal, cache: "no-store", headers: { "X-API-Key": this.apiKey, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
    } catch (e: any) {
      throw new PriceLabsError(e?.name === "AbortError" ? "PriceLabs n'a pas répondu à temps." : "PriceLabs est injoignable depuis le serveur.");
    } finally { clearTimeout(timer); }
    if (!res.ok) throw errorForStatus(res.status);
    try { return await res.json(); } catch { throw new PriceLabsError("Réponse PriceLabs illisible."); }
  }

  async listListings(): Promise<PlListing[]> {
    const j = await this.call("/listings");
    this.tap?.("listings", {}, j);
    return unwrapListings(j);
  }
  async getPrices(id: string, pms: string, from: ISODate, to: ISODate): Promise<any> {
    const j = await this.call("/listing_prices", { method: "POST", body: { listings: [{ id, pms, dateFrom: from, dateTo: to }] } });
    this.tap?.("prices", { id, pms, from, to }, j);
    return unwrapPriceItem(j, id);
  }
  async getNeighborhood(id: string, pms: string): Promise<any> {
    const j = await this.call(`/neighborhood_data?listing_id=${encodeURIComponent(id)}&pms=${encodeURIComponent(pms)}`, { timeoutMs: 60000 });
    this.tap?.("neighborhood", { id, pms }, j);
    return j?.data ?? null;
  }
  /** Réservations par date d'arrivée, toutes pages (borne de sécurité : 30 pages de 100). */
  async getReservations(id: string, pms: string, from: ISODate, to: ISODate): Promise<any[]> {
    const rows: any[] = [];
    for (let page = 0; page < 30; page++) {
      const j = await this.call(`/reservation_data?pms=${encodeURIComponent(pms)}&listing_id=${encodeURIComponent(id)}&start_date=${from}&end_date=${to}&limit=100&offset=${page * 100}`);
      rows.push(...(Array.isArray(j?.data) ? j.data : []));
      if (!j?.next_page) break;
    }
    this.tap?.("reservations", { id, pms, from, to }, rows);
    return rows;
  }
}

/**
 * Adaptateur utilisé par l'application. `usePriceLabsAdapter` ne sert qu'aux tests (Vitest) : il est refusé en production,
 * où l'adaptateur est toujours l'API HTTP (l'adresse de l'API se règle par PRICELABS_API_BASE, voir `.env.example`).
 */
let override: PriceLabsPortFactory | null = null;
export const priceLabsFor: PriceLabsPortFactory = (apiKey) => (override ? override(apiKey) : new HttpPriceLabs(apiKey));
export function usePriceLabsAdapter(factory: PriceLabsPortFactory | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("usePriceLabsAdapter : réservé aux tests.");
  override = factory;
}

export const horizon = (today: ISODate) => ({ from: today, to: addDays(today, 90), histFrom: addDays(today, -365), histTo: addDays(today, 366) });
