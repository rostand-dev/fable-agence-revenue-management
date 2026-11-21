import fs from "node:fs";
import type { ISODate } from "../dates";
import { errorForStatus, unwrapListings, unwrapPriceItem } from "./pricelabs";
import type { PlListing } from "./pricelabs-map";
import type { PriceLabsAdapterKind, PriceLabsPort } from "./pricelabs-port";
import type { Endpoint, Scenario } from "./pricelabs-scenarios";

/**
 * Faux adaptateur PriceLabs en mémoire (US-044). Il passe par les mêmes fonctions de lecture de réponse que l'adaptateur HTTP
 * (`unwrapListings`, `unwrapPriceItem`, `errorForStatus`) : les erreurs, les messages et les formes de données sont ceux de la production.
 * Il consigne chaque appel (`calls`) pour que les tests vérifient ce qui a été lu, et que rien d'autre n'a été demandé.
 */
export type FakeCall = { endpoint: Endpoint; args: unknown[] };

export class FakePriceLabs implements PriceLabsPort {
  readonly adapter: PriceLabsAdapterKind = "FAKE";
  readonly calls: FakeCall[] = [];
  private failedSoFar: Partial<Record<Endpoint, number>> = {};
  /** Le jeu de données reste modifiable entre deux lectures : un test peut changer un prix, retirer une annonce, couper le marché. */
  constructor(public scenario: Scenario) {}

  private gate(endpoint: Endpoint, args: unknown[]): void {
    this.calls.push({ endpoint, args });
    const hard = this.scenario.failures?.[endpoint];
    if (hard) throw errorForStatus(hard);
    const flaky = this.scenario.flaky?.[endpoint];
    if (flaky && (this.failedSoFar[endpoint] ?? 0) < flaky.times) { this.failedSoFar[endpoint] = (this.failedSoFar[endpoint] ?? 0) + 1; throw errorForStatus(flaky.status); }
  }

  async listListings(): Promise<PlListing[]> { this.gate("listings", []); return unwrapListings({ listings: this.scenario.listings }); }
  async getPrices(id: string, pms: string, from: ISODate, to: ISODate): Promise<any> {
    this.gate("prices", [id, pms, from, to]);
    const item = this.scenario.prices[id];
    // même réponse que le faux serveur pour une annonce inconnue
    if (!item) return unwrapPriceItem([{ id, pms, error: "Listing not found", error_status: "LISTING_NOT_PRESENT" }], id);
    if (item.error_status || item.error) return unwrapPriceItem([item], id);
    return unwrapPriceItem([{ ...item, data: (item.data ?? []).filter((d: any) => d.date >= from && d.date <= to) }], id);
  }
  async getNeighborhood(id: string, _pms: string): Promise<any> { this.gate("neighborhood", [id]); return this.scenario.neighborhood[id] ?? null; }
  async getReservations(id: string, pms: string, from: ISODate, to: ISODate): Promise<any[]> {
    this.gate("reservations", [id, pms, from, to]);
    return (this.scenario.reservations[id] ?? []).filter((r) => String(r.check_in).slice(0, 10) >= from && String(r.check_in).slice(0, 10) <= to);
  }
}

/** Réponses enregistrées auprès de PriceLabs (puis rendues anonymes), au format du jeu de données : voir `scripts/pricelabs-record.ts`. */
export type ReplayFixture = { meta: { recordedAt: string; note: string }; scenario: Scenario };

/** Rejoue une fixture à l'identique, sans réseau : mêmes lectures, mêmes erreurs, mêmes résultats à chaque exécution. */
export class ReplayPriceLabs extends FakePriceLabs {
  readonly adapter: PriceLabsAdapterKind = "REPLAY";
  constructor(fixture: ReplayFixture) {
    if (!fixture?.scenario || !Array.isArray(fixture.scenario.listings)) throw new Error("Fixture PriceLabs invalide : jeu de données absent.");
    super(fixture.scenario);
  }
  static fromFile(path: string): ReplayPriceLabs { return new ReplayPriceLabs(JSON.parse(fs.readFileSync(path, "utf8")) as ReplayFixture); }
}
