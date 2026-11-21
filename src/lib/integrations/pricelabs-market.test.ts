import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { FakePriceLabs } from "./pricelabs-fake";
import { mapMarket, mapPrices, type PlMarketDay } from "./pricelabs-map";
import { analyzeMarket, MIN_COMPSET } from "./pricelabs-market";
import { buildScenario, type ScenarioName } from "./pricelabs-scenarios";

const TODAY = "2026-11-21", RANGE = { from: TODAY, to: addDays(TODAY, 90) };
const md = (i: number, over: Partial<PlMarketDay> = {}): PlMarketDay => ({ date: addDays(TODAY, i), marketOccupancy: 0.6, marketAdrCents: 12000, pricePercentile: 50, event: null, ...over });
const rows = (over: (i: number) => Partial<PlMarketDay> = () => ({})) => Array.from({ length: 91 }, (_, i) => md(i, over(i)));
const input = (market: PlMarketDay[], over: object = {}) => ({ market, category: "2", listingsUsed: 120, source: "Nearby Listings", hasData: true, ...over });
const codes = (r: ReturnType<typeof analyzeMarket>) => r.issues.map((i) => i.code);

describe("marché / compset selon les capacités", () => {
  it("données complètes : disponible, aucun point", () => {
    const r = analyzeMarket(input(rows()), RANGE, null);
    expect(r).toMatchObject({ capability: "AVAILABLE", expected: 91, withOccupancy: 91, withPrice: 91, coverage: 1, listingsUsed: 120, issues: [] });
  });
  it("lecture en échec : illisible, message de l'erreur, jours précédents conservés et comptés", () => {
    const r = analyzeMarket(input([]), RANGE, "PriceLabs a répondu avec une erreur (500).", 42);
    expect(r).toMatchObject({ capability: "UNAVAILABLE", keptDays: 42, withOccupancy: 0, category: null });
    expect(r.issues[0].message).toContain("42 jours de marché de la lecture précédente sont conservés");
    expect(analyzeMarket(input([]), RANGE, "Erreur.", 0).issues[0].message).toContain("Aucune lecture de marché précédente");
  });
  it("aucune donnée de marché : aucune donnée, signaux inconnus", () => {
    expect(analyzeMarket(input([], { hasData: false }), RANGE, null)).toMatchObject({ capability: "NONE", issues: [{ code: "NO_DATA" }] });
  });
  it("données sans catégorie exploitable : aucune donnée", () => {
    expect(codes(analyzeMarket(input(rows(), { category: null }), RANGE, null))).toEqual(["NO_CATEGORY"]);
  });
  it("compset réduit : limité ; compset inconnu : information seule, donc encore disponible", () => {
    const small = analyzeMarket(input(rows(), { listingsUsed: MIN_COMPSET - 1 }), RANGE, null);
    expect(small.capability).toBe("LIMITED"); expect(codes(small)).toEqual(["SMALL_COMPSET"]);
    expect(analyzeMarket(input(rows(), { listingsUsed: MIN_COMPSET }), RANGE, null).capability).toBe("AVAILABLE");
    const unknown = analyzeMarket(input(rows(), { listingsUsed: null }), RANGE, null);
    expect(unknown.capability).toBe("AVAILABLE"); expect(codes(unknown)).toEqual(["UNKNOWN_COMPSET"]);
  });
  it("couverture d'occupation insuffisante : limité, jours inconnus comptés", () => {
    const r = analyzeMarket(input(rows((i) => (i % 2 ? { marketOccupancy: null } : {}))), RANGE, null);
    expect(r.capability).toBe("LIMITED"); expect(codes(r)).toEqual(["LOW_OCCUPANCY_COVERAGE"]); expect(r.withOccupancy).toBe(46);
    expect(analyzeMarket(input(rows((i) => (i < 19 ? { marketOccupancy: null } : {}))), RANGE, null).capability).toBe("LIMITED"); // 72/91 = 79 % < 80 %
    expect(analyzeMarket(input(rows((i) => (i < 18 ? { marketOccupancy: null } : {}))), RANGE, null).capability).toBe("AVAILABLE"); // 73/91 = 80 %
  });
  it("le seuil de couverture se juge sur la valeur exacte : 79,5 % est limité même si l'affichage arrondit à 80", () => {
    const wide = { from: TODAY, to: addDays(TODAY, 199) };
    const market = Array.from({ length: 200 }, (_, i) => md(i, i < 41 ? { marketOccupancy: null } : {})); // 159 / 200 = 79,5 %
    const r = analyzeMarket(input(market), wide, null);
    expect(r.coverage).toBe(0.8); expect(codes(r)).toContain("LOW_OCCUPANCY_COVERAGE");
  });
  it("aucun prix de marché : limité", () => {
    expect(codes(analyzeMarket(input(rows(() => ({ marketAdrCents: null }))), RANGE, null))).toEqual(["NO_PRICE_BENCHMARK"]);
  });
  it("jours hors plage ignorés", () => {
    expect(analyzeMarket(input([...rows(), md(200)]), RANGE, null).withOccupancy).toBe(91);
  });
  it("scénarios fictifs : nominal disponible, compset réduit limité", async () => {
    const run = async (n: ScenarioName) => { const p = new FakePriceLabs(buildScenario(n, TODAY)); const [l] = await p.listListings();
      const days = mapPrices(await p.getPrices(l.id, l.pms, TODAY, addDays(TODAY, 90))); const data = await p.getNeighborhood(l.id, l.pms);
      return analyzeMarket({ ...mapMarket(data, l.bedrooms, days), hasData: !!data }, RANGE, null); };
    expect((await run("nominal")).capability).toBe("AVAILABLE");
    const sparse = await run("market-sparse");
    expect(sparse.capability).toBe("LIMITED"); expect(codes(sparse)).toContain("SMALL_COMPSET");
  });
});
