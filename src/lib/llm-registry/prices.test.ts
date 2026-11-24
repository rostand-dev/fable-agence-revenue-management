import { describe, expect, it } from "vitest";
import { CATALOG, isMovingAlias } from "./catalog";
import { computeCostUsd, decidePrice, parseLitellmPrices, parsePriceOverrides, readLitellmEntry, roundUsd } from "./prices";
import { DEFAULT_PRICES_URL, pricesUrl, syncIntervalHours, usdEurRate } from "./config";

// Extraits fidèles du fichier LiteLLM (prix par jeton) relevés le 24/11/2026.
const FILE = {
  "claude-haiku-5-5": { input_cost_per_token: 1e-7, output_cost_per_token: 5e-7, supports_response_schema: true, max_input_tokens: 1000000, max_output_tokens: 128000,
    input_cost_per_token_above_100k_tokens: 5e-7, output_cost_per_token_above_100k_tokens: 2.5e-6, input_cost_per_token_above_100k_tokens_batches: 2.5e-7, output_cost_per_token_above_100k_tokens_batches: 1.25e-6 },
  "claude-sonnet-5-5": { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, supports_response_schema: true, max_input_tokens: 1000000, max_output_tokens: 128000 },
  "gpt-6-luna": { input_cost_per_token: 1e-7, output_cost_per_token: 5e-7, supports_response_schema: true, input_cost_per_token_above_272k_tokens: 2e-7, output_cost_per_token_above_272k_tokens: 7.5e-7, input_cost_per_token_above_272k_tokens_priority: 4e-7, output_cost_per_token_above_272k_tokens_priority: 1.5e-6 },
  "gpt-6.1-terra": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, supports_response_schema: true },
  "mistral/mistral-small-2603": { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7, supports_response_schema: true, max_input_tokens: 262144, max_output_tokens: 262144 },
  "mistral/mistral-small-latest": { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7 },
};

describe("prix : lecture du fichier LiteLLM", () => {
  const facts = parseLitellmPrices(FILE);
  it("les 5 modèles du catalogue sont lus, en USD par million de jetons sans bruit de virgule flottante", () => {
    expect([...facts.keys()].sort()).toEqual(CATALOG.map((m) => m.modelId).sort());
    expect(facts.get("claude-haiku-5-5")!.price).toMatchObject({ inputPerMtok: 0.1, outputPerMtok: 0.5 });
    expect(facts.get("gpt-6.1-terra")!.price).toMatchObject({ inputPerMtok: 1, outputPerMtok: 5 });
    expect(facts.get("claude-sonnet-5-5")!.price).toMatchObject({ inputPerMtok: 2, outputPerMtok: 10 });
    expect(facts.get("mistral-small-2603")!.price).toMatchObject({ inputPerMtok: 0.15, outputPerMtok: 0.6 });
  });
  it("palier de Haiku 5.5 : 5 fois plus au-delà de 100 000 jetons ; seuls les paliers standard sont lus (pas batch ni priority)", () => {
    expect(facts.get("claude-haiku-5-5")!.price.long).toEqual({ thresholdTokens: 100000, inputPerMtok: 0.5, outputPerMtok: 2.5 });
    expect(facts.get("gpt-6-luna")!.price.long).toEqual({ thresholdTokens: 272000, inputPerMtok: 0.2, outputPerMtok: 0.75 });
    expect(facts.get("claude-sonnet-5-5")!.price.long).toBeNull();
  });
  it("support du JSON structuré et tailles repris du fichier", () => {
    expect(facts.get("claude-haiku-5-5")).toMatchObject({ supportsJson: true, maxInputTokens: 1000000, maxOutputTokens: 128000 });
  });
  it("l'alias mouvant « mistral-small-latest » n'est jamais lu : seul l'identifiant figé du catalogue l'est", () => {
    expect([...facts.keys()]).not.toContain("mistral-small-latest");
    expect(isMovingAlias("mistral-small-latest")).toBe(true);
    expect(isMovingAlias("mistral-small-2603")).toBe(false);
    expect(CATALOG.some((m) => isMovingAlias(m.modelId))).toBe(false);
  });
  it("un modèle absent du fichier, sans prix ou à prix invalide n'a pas d'entrée (donc jamais routé)", () => {
    expect(parseLitellmPrices({}).size).toBe(0);
    expect(parseLitellmPrices({ "gpt-6-luna": { input_cost_per_token: 1e-7 } }).has("gpt-6-luna")).toBe(false);
    expect(parseLitellmPrices({ "gpt-6-luna": { input_cost_per_token: "x", output_cost_per_token: 1 } }).has("gpt-6-luna")).toBe(false);
    expect(readLitellmEntry(null)).toBeNull();
    expect(parseLitellmPrices([1, 2]).size).toBe(0);
    expect(parseLitellmPrices(null).size).toBe(0);
  });
});

describe("prix : décision face au dernier prix validé", () => {
  const p = { inputPerMtok: 0.1, outputPerMtok: 0.5, long: null };
  it("nouveau modèle → enregistré ; prix identique → rien ; prix modifié → signalé", () => {
    expect(decidePrice(null, p)).toBe("RECORD");
    expect(decidePrice(p, { ...p })).toBe("KEEP");
    expect(decidePrice(p, { ...p, outputPerMtok: 0.6 })).toBe("FLAG");
    expect(decidePrice(p, { ...p, long: { thresholdTokens: 1, inputPerMtok: 1, outputPerMtok: 1 } })).toBe("FLAG");
  });
});

describe("prix : surcharges LLM_PRICE_OVERRIDES", () => {
  it("vide ou absente = aucune surcharge, sans erreur", () => {
    expect(parsePriceOverrides(undefined)).toEqual({ overrides: new Map(), error: null });
    expect(parsePriceOverrides("  ").error).toBeNull();
    expect(parsePriceOverrides("{}").overrides.size).toBe(0);
  });
  it("lit un prix simple et un palier long", () => {
    const { overrides, error } = parsePriceOverrides('{"gpt-6-luna":{"input":0.3,"output":0.9},"claude-haiku-5-5":{"input":0.1,"output":0.5,"longThresholdTokens":100000,"longInput":0.5,"longOutput":2.5}}');
    expect(error).toBeNull();
    expect(overrides.get("gpt-6-luna")).toEqual({ inputPerMtok: 0.3, outputPerMtok: 0.9, long: null });
    expect(overrides.get("claude-haiku-5-5")!.long).toEqual({ thresholdTokens: 100000, inputPerMtok: 0.5, outputPerMtok: 2.5 });
  });
  it("JSON invalide, champ inconnu ou prix négatif : aucune surcharge appliquée et erreur explicite", () => {
    for (const bad of ["{pas du json", '{"m":{"input":-1,"output":1}}', '{"m":{"input":1}}', '{"m":{"input":1,"output":1,"x":2}}', "[1]"]) {
      const r = parsePriceOverrides(bad);
      expect(r.overrides.size).toBe(0);
      expect(r.error).toMatch(/LLM_PRICE_OVERRIDES/);
    }
  });
});

describe("coût d'un appel", () => {
  const haiku = parseLitellmPrices(FILE).get("claude-haiku-5-5")!.price;
  it("calcule au prix standard", () => {
    // 10 000 jetons d'entrée à 0,10 $/M + 1 000 de sortie à 0,50 $/M = 0,001 + 0,0005
    expect(computeCostUsd(haiku, 10_000, 1_000)).toBeCloseTo(0.0015, 10);
  });
  it("au-delà du palier, toute la requête passe au prix long (Haiku 5.5 : 5 fois plus)", () => {
    expect(computeCostUsd(haiku, 100_000, 0)).toBeCloseTo(0.01, 10);
    expect(computeCostUsd(haiku, 100_001, 0)).toBeCloseTo(0.0500005, 10);
  });
  it("prix ou jetons inconnus : null, jamais zéro ni une valeur inventée", () => {
    expect(computeCostUsd(null, 10, 10)).toBeNull();
    expect(computeCostUsd(undefined, 10, 10)).toBeNull();
    expect(computeCostUsd(haiku, null, 10)).toBeNull();
    expect(computeCostUsd(haiku, 10, undefined)).toBeNull();
    expect(computeCostUsd(haiku, 0, 0)).toBe(0);
  });
  it("arrondi à 6 décimales", () => { expect(roundUsd(0.00123456789)).toBe(0.001235); });
});

describe("configuration du routeur", () => {
  it("adresse du fichier de prix : https seulement (http local toléré pour les tests), sinon défaut", () => {
    expect(pricesUrl({})).toBe(DEFAULT_PRICES_URL);
    expect(pricesUrl({ LLM_PRICES_URL: "https://exemple.test/p.json" })).toBe("https://exemple.test/p.json");
    expect(pricesUrl({ LLM_PRICES_URL: "http://127.0.0.1:4012/p.json" })).toBe("http://127.0.0.1:4012/p.json");
    expect(pricesUrl({ LLM_PRICES_URL: "http://exemple.test/p.json" })).toBe(DEFAULT_PRICES_URL);
    expect(pricesUrl({ LLM_PRICES_URL: "pas une adresse" })).toBe(DEFAULT_PRICES_URL);
  });
  it("fréquence du job : 24 h par défaut, 0 désactive, valeur invalide = défaut", () => {
    expect(syncIntervalHours({})).toBe(24);
    expect(syncIntervalHours({ LLM_SYNC_INTERVAL_HOURS: "0" })).toBe(0);
    expect(syncIntervalHours({ LLM_SYNC_INTERVAL_HOURS: "6" })).toBe(6);
    for (const bad of ["abc", "-1", "500", "1.5"]) expect(syncIntervalHours({ LLM_SYNC_INTERVAL_HOURS: bad })).toBe(24);
  });
  it("taux USD→EUR : défaut 0,92, virgule acceptée, hors bornes = défaut", () => {
    expect(usdEurRate({})).toBe(0.92);
    expect(usdEurRate({ LLM_USD_EUR_RATE: "0,85" })).toBe(0.85);
    for (const bad of ["0", "50", "x"]) expect(usdEurRate({ LLM_USD_EUR_RATE: bad })).toBe(0.92);
  });
});
