import type { ISODate } from "../dates";
import { errorForStatus } from "./pricelabs";
import type { FakePriceLabs } from "./pricelabs-fake";
import { mapOverride, requestHash, toUnits } from "./pricelabs-write";
import type { DatedPrice, ListingLimits, PriceLabsWriteAdapterKind, PriceLabsWritePort, RemoteOverride, WriteReceipt } from "./pricelabs-write-port";

/**
 * Faux adaptateur d'ÉCRITURE PriceLabs en mémoire (épic 9). Il écrit dans le même jeu de données que le faux adaptateur de lecture qu'on lui donne :
 * un prix minimum posé ici est relu par `listListings()`, comme chez PriceLabs. Les prix datés ne changent pas la grille `listing_prices`
 * (PriceLabs la recalcule au prochain rafraîchissement, une fois par jour) : ils ne se lisent que par `getOverrides`.
 * Chaque appel est consigné dans `calls` ; `failWrites` simule un refus ou une panne.
 */
export type FakeWriteCall = { method: string; args: unknown[] };
export class FakePriceLabsWriter implements PriceLabsWritePort {
  readonly adapter: PriceLabsWriteAdapterKind = "FAKE";
  readonly calls: FakeWriteCall[] = [];
  /** Dérogations en vigueur, par annonce puis par date (forme brute de l'API) */
  readonly overrides = new Map<string, Map<string, Record<string, unknown>>>();
  /** Statut HTTP d'échec renvoyé aux `times` prochaines écritures (par défaut toutes) */
  failWrites: { status: number; times?: number } | null = null;
  /** Rend la relecture des dérogations illisible (réponse hors contrat) */
  brokenOverrideRead = false;
  constructor(public read: FakePriceLabs) {}

  private gate(method: string, args: unknown[], write = true): void {
    this.calls.push({ method, args });
    if (write && this.failWrites && (this.failWrites.times === undefined || this.failWrites.times > 0)) {
      if (this.failWrites.times !== undefined) this.failWrites.times -= 1;
      throw errorForStatus(this.failWrites.status);
    }
  }
  private receipt(method: "POST" | "DELETE", endpoint: string, body: unknown, summary: Record<string, unknown>): WriteReceipt {
    return { method, endpoint, status: method === "DELETE" ? 204 : 200, sentAt: new Date().toISOString(), requestHash: requestHash(body), summary, adapter: "FAKE" };
  }
  private known(id: string) { if (!this.read.scenario.listings.some((x: any) => String(x.id) === id)) throw errorForStatus(404); }
  private of(id: string) { let m = this.overrides.get(id); if (!m) this.overrides.set(id, (m = new Map())); return m; }

  async setListingLimits(id: string, pms: string, l: ListingLimits): Promise<WriteReceipt> {
    this.gate("setListingLimits", [id, pms, l]);
    const row = this.read.scenario.listings.find((x: any) => String(x.id) === id);
    if (!row) throw errorForStatus(404);
    if ([l.minCents, l.baseCents, l.maxCents].some((v) => v !== undefined && (!Number.isInteger(v) || v <= 0))) throw errorForStatus(400);
    if (l.minCents !== undefined) row.min = toUnits(l.minCents);
    if (l.baseCents !== undefined) row.base = toUnits(l.baseCents);
    if (l.maxCents !== undefined) row.max = toUnits(l.maxCents);
    return this.receipt("POST", "/listings", { id, pms, ...l }, { listingId: id, ...l });
  }
  async setPriceOverrides(id: string, pms: string, items: DatedPrice[], opts: { currency: string | null; reason: string }): Promise<WriteReceipt> {
    this.gate("setPriceOverrides", [id, pms, items, opts]);
    this.known(id);
    if (items.some((i) => !Number.isInteger(i.priceCents) || i.priceCents <= 0)) throw errorForStatus(400);
    for (const i of items) this.of(id).set(i.date, { date: i.date, price: String(toUnits(i.priceCents)), price_type: "fixed", ...(opts.currency ? { currency: opts.currency } : {}), reason: opts.reason });
    return this.receipt("POST", `/listings/${id}/overrides`, { pms, items }, { listingId: id, dates: items.map((i) => i.date), prices: items.map((i) => i.priceCents) });
  }
  async restoreOverrides(id: string, pms: string, previous: RemoteOverride[]): Promise<WriteReceipt> {
    this.gate("restoreOverrides", [id, pms, previous]);
    this.known(id);
    for (const o of previous) this.of(id).set(o.date, { ...o.raw });
    return this.receipt("POST", `/listings/${id}/overrides`, { pms, previous: previous.map((o) => o.raw) }, { listingId: id, dates: previous.map((o) => o.date), restored: true });
  }
  async deleteOverrides(id: string, pms: string, dates: ISODate[]): Promise<WriteReceipt> {
    this.gate("deleteOverrides", [id, pms, dates]);
    this.known(id);
    for (const d of dates) this.of(id).delete(d);
    return this.receipt("DELETE", `/listings/${id}/overrides`, { pms, dates }, { listingId: id, dates });
  }
  async getOverrides(id: string, pms: string, from: ISODate, to: ISODate): Promise<RemoteOverride[]> {
    this.gate("getOverrides", [id, pms, from, to], false);
    if (this.brokenOverrideRead) throw new Error("Réponse PriceLabs inattendue : liste des dérogations absente.");
    return [...this.of(id).values()].map(mapOverride).filter((o): o is RemoteOverride => !!o && o.date >= from && o.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  }
}
