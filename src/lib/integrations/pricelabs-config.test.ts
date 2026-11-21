import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { analyzeGrid, diffConfig, normalizeConfig, type PricingConfiguration } from "./pricelabs-config";
import { FakePriceLabs } from "./pricelabs-fake";
import { mapListing, mapPrices, type PlDay } from "./pricelabs-map";
import { buildScenario, type ScenarioName } from "./pricelabs-scenarios";

const TODAY = "2026-11-21", RANGE = { from: TODAY, to: addDays(TODAY, 90) };
const CFG: PricingConfiguration = { listingId: "l1", pms: "superhote", currency: "EUR", basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 25000, pushEnabled: true };
const day = (i: number, over: Partial<PlDay> = {}): PlDay => ({ date: addDays(TODAY, i), state: "FREE", priceCents: 12000, recommendedPriceCents: 12000, sentPriceCents: null, minStay: 2, rule: null, ...over });
const full = (over: (i: number) => Partial<PlDay> = () => ({})) => Array.from({ length: 91 }, (_, i) => day(i, over(i)));
const codes = (r: ReturnType<typeof analyzeGrid>) => r.issues.map((i) => i.code);
const scenario = async (n: ScenarioName) => { const p = new FakePriceLabs(buildScenario(n, TODAY)); const [l] = await p.listListings(); return { cfg: normalizeConfig(l), days: mapPrices(await p.getPrices(l.id, l.pms, TODAY, addDays(TODAY, 90))) }; };

describe("configuration PriceLabs", () => {
  it("normalise l'annonce : prix en centimes, synchronisation, devise", () => {
    expect(normalizeConfig(mapListing({ id: "l1", pms: "superhote", name: "X", min: 83, base: 116, max: 250, currency: "EUR", push_enabled: true }))).toEqual(CFG);
  });
  it("un changement d'annonce rattachée n'est pas un changement de configuration", () => {
    expect(diffConfig(CFG, { ...CFG, listingId: "autre", minPriceCents: 1 })).toEqual([]);
    expect(diffConfig(CFG, { ...CFG, pms: "autre" })).toEqual([]);
  });
  it("valeur inconnue → connue (et l'inverse) est un changement, undefined vaut inconnu", () => {
    expect(diffConfig({ ...CFG, minPriceCents: null }, CFG).map((c) => [c.key, c.from, c.to])).toEqual([["minPriceCents", null, "83 €"]]);
    expect(diffConfig({ ...CFG, currency: undefined as any }, { ...CFG, currency: null })).toEqual([]);
  });
  it("première lecture ou aucun changement : rien à signaler", () => {
    expect(diffConfig(null, CFG)).toEqual([]);
    expect(diffConfig(CFG, { ...CFG })).toEqual([]);
  });
  it("décrit chaque changement avec ancienne et nouvelle valeur, en clair", () => {
    const ch = diffConfig(CFG, { ...CFG, minPriceCents: 9000, pushEnabled: false, maxPriceCents: null });
    expect(ch.map((c) => [c.label, c.from, c.to])).toEqual([["Prix minimum", "83 €", "90 €"], ["Prix maximum", "250 €", null], ["Synchronisation des prix", "active", "désactivée"]]);
  });
});

describe("contrôle de la grille de prix futurs", () => {
  it("grille complète et cohérente : aucun point, qualité 100 %", () => {
    const r = analyzeGrid(full(), RANGE, CFG);
    expect(r).toMatchObject({ expected: 91, received: 91, missing: 0, unknownPrices: 0, belowMin: 0, aboveMax: 0, score: 100, issues: [] });
  });
  it("jours manquants : signalés avec leurs dates, la qualité baisse", () => {
    const r = analyzeGrid(full().slice(0, 60), RANGE, CFG);
    expect(r.missing).toBe(31); expect(codes(r)).toEqual(["MISSING_DAYS"]);
    expect(r.issues[0].dates).toHaveLength(10); expect(r.issues[0].dates![0]).toBe(addDays(TODAY, 60));
    expect(r.score).toBe(Math.round((100 * 60) / 91));
  });
  it("prix inconnu sur une nuit libre : signalé ; sur une nuit réservée ou bloquée : normal", () => {
    const r = analyzeGrid(full((i) => (i === 3 ? { priceCents: null } : i === 4 ? { state: "BOOKED", priceCents: null } : i === 5 ? { state: "BLOCKED", priceCents: null } : {})), RANGE, CFG);
    expect(r.unknownPrices).toBe(1); expect(codes(r)).toEqual(["UNKNOWN_PRICES"]);
    expect(r.score).toBe(Math.round((100 * 90) / 91));
  });
  it("prix hors des bornes : sous le minimum et au-dessus du maximum ; une nuit réservée n'est jamais jugée", () => {
    const r = analyzeGrid(full((i) => (i === 1 ? { priceCents: 8000 } : i === 2 ? { priceCents: 26000 } : i === 3 ? { state: "BOOKED", priceCents: null, recommendedPriceCents: 5000 } : {})), RANGE, CFG);
    expect([r.belowMin, r.aboveMax]).toEqual([1, 1]); expect(codes(r)).toEqual(["BELOW_MIN", "ABOVE_MAX"]);
  });
  it("prix pile sur le minimum ou le maximum : conforme", () => {
    expect(analyzeGrid(full((i) => (i === 1 ? { priceCents: 8300 } : i === 2 ? { priceCents: 25000 } : {})), RANGE, CFG).issues).toEqual([]);
  });
  it("bornes incohérentes : minimum au-dessus du prix de base, de base au-dessus du maximum, minimum au-dessus du maximum", () => {
    expect(codes(analyzeGrid(full(), RANGE, { ...CFG, minPriceCents: 14000 }))).toContain("MIN_ABOVE_BASE");
    expect(codes(analyzeGrid(full(), RANGE, { ...CFG, maxPriceCents: 11000 }))).toContain("BASE_OUTSIDE_BOUNDS");
    expect(codes(analyzeGrid(full(), RANGE, { ...CFG, minPriceCents: 30000 }))).toContain("MIN_ABOVE_MAX");
  });
  it("plusieurs incohérences de bornes se cumulent au lieu de se masquer", () => {
    expect(codes(analyzeGrid(full(), RANGE, { ...CFG, minPriceCents: 30000, maxPriceCents: 10000 }))).toEqual(expect.arrayContaining(["MIN_ABOVE_MAX", "MIN_ABOVE_BASE", "BASE_OUTSIDE_BOUNDS"]));
  });
  it("sans bornes : information, pas d'avertissement de prix ; sans configuration : pas de contrôle de bornes", () => {
    const r = analyzeGrid(full(), RANGE, { ...CFG, minPriceCents: null, maxPriceCents: null });
    expect(r.issues).toEqual([{ code: "NO_BOUNDS", severity: "INFO", message: expect.any(String) }]);
    expect(analyzeGrid(full(), RANGE, null).issues).toEqual([]);
  });
  it("la liste de dates indique le total quand elle est tronquée", () => {
    const r = analyzeGrid(full().slice(0, 60), RANGE, CFG);
    expect(r.issues[0]).toMatchObject({ total: 31 }); expect(r.issues[0].dates).toHaveLength(10);
  });
  it("aucune donnée : tout est manquant, qualité 0 %", () => {
    expect(analyzeGrid([], RANGE, CFG)).toMatchObject({ received: 0, missing: 91, score: 0 });
  });
  it("jours en doublon ou hors plage : ne gonflent pas les compteurs de jours manquants", () => {
    const r = analyzeGrid([...full(), day(200), day(3, { priceCents: 9000 })], RANGE, CFG);
    expect(r).toMatchObject({ missing: 0, received: 91, score: 100 });
  });
  it("scénarios fictifs : nominal propre, grille partielle et minimum incohérent détectés", async () => {
    const nominal = await scenario("nominal"); expect(analyzeGrid(nominal.days, RANGE, nominal.cfg).issues).toEqual([]);
    const partial = await scenario("partial-grid"); expect(codes(analyzeGrid(partial.days, RANGE, partial.cfg))).toEqual(["MISSING_DAYS", "UNKNOWN_PRICES"]);
    const bad = await scenario("min-above-base"); expect(codes(analyzeGrid(bad.days, RANGE, bad.cfg))).toContain("MIN_ABOVE_BASE");
  });
});
