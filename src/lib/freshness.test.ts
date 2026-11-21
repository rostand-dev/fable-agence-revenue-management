import { describe, expect, it } from "vitest";
import { canonicalJson, contentHash } from "./services/snapshots";
import { freshnessOf, MAX_AGE_HOURS } from "./freshness";

const NOW = new Date("2026-11-21T12:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("fraîcheur (blueprint §7.4)", () => {
  it("seuils par défaut : réservations 24 h, disponibilité 6 h, prix 24 h, marché 48 h, promotions 7 jours", () => {
    expect(MAX_AGE_HOURS).toEqual({ RESERVATIONS: 24, AVAILABILITY: 6, PRICING: 24, MARKET: 48, PROMOTIONS: 168, CONFIG: 24 });
  });
  it("frais juste avant le seuil, périmé au seuil", () => {
    expect(freshnessOf("PRICING", ago(23.9), NOW).state).toBe("FRESH");
    expect(freshnessOf("PRICING", ago(24), NOW).state).toBe("STALE");
    expect(freshnessOf("MARKET", ago(47), NOW).state).toBe("FRESH");
    expect(freshnessOf("MARKET", ago(48), NOW).state).toBe("STALE");
    expect(freshnessOf("AVAILABILITY", ago(6), NOW).state).toBe("STALE");
  });
  it("jamais lu : MISSING, sans âge", () => {
    expect(freshnessOf("PRICING", null, NOW)).toEqual({ state: "MISSING", ageHours: null, maxHours: 24 });
    expect(freshnessOf("MARKET", "pas une date", NOW).state).toBe("MISSING");
  });
  it("une observation datée du futur (horloge décalée) est neuve, jamais d'âge négatif", () => {
    const f = freshnessOf("PRICING", new Date(NOW.getTime() + 3_600_000), NOW);
    expect(f).toMatchObject({ state: "FRESH", ageHours: 0 });
  });
  it("accepte une date ISO en texte", () => {
    expect(freshnessOf("PRICING", ago(2).toISOString(), NOW)).toMatchObject({ state: "FRESH", ageHours: 2 });
  });
});

describe("empreinte de contenu", () => {
  it("ne dépend ni de l'ordre des champs ni des champs indéfinis", () => {
    expect(contentHash({ a: 1, b: { c: [1, 2], d: null } })).toBe(contentHash({ b: { d: null, c: [1, 2] }, a: 1, z: undefined }));
  });
  it("change dès qu'une valeur change, y compris dans un tableau", () => {
    expect(contentHash({ a: [1, 2] })).not.toBe(contentHash({ a: [2, 1] }));
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: "1" }));
  });
  it("JSON canonique stable", () => {
    expect(canonicalJson({ b: 1, a: [true, null] })).toBe('{"a":[true,null],"b":1}');
  });
});
