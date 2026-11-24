import { describe, expect, it } from "vitest";
import { applyListing, parseAnthropicList, parseMistralList, parseOpenAiList, routableVerdict, DEPRECATION_MARGIN_DAYS } from "./availability";
import { costOfTried } from "./pricebook";
import { syncDue } from "./job";

const NOW = new Date("2026-11-24T12:00:00Z");
const day = 86400_000;

describe("disponibilité : listes officielles", () => {
  it("Anthropic : cycle de vie, dates, tailles et JSON structuré", () => {
    const l = parseAnthropicList({ data: [
      { type: "model", id: "claude-haiku-5-5", lifecycle: "active", deprecated_at: null, retires_at: null, max_input_tokens: 1000000, max_tokens: 128000, capabilities: { structured_outputs: { supported: true } } },
      { type: "model", id: "claude-old", lifecycle: "deprecated", deprecated_at: "2026-10-01T00:00:00Z", retires_at: "2026-12-01T00:00:00Z", max_input_tokens: null, max_tokens: null, capabilities: null },
      { id: "claude-gone", lifecycle: "retired" }, { nope: 1 },
    ] });
    expect(l.map((m) => [m.modelId, m.lifecycle])).toEqual([["claude-haiku-5-5", "ACTIVE"], ["claude-old", "DEPRECATED"], ["claude-gone", "RETIRED"]]);
    expect(l[0]).toMatchObject({ maxInputTokens: 1000000, maxOutputTokens: 128000, supportsJson: true });
    expect(l[1].retiresAt).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect(l[1].supportsJson).toBeNull();
    expect(parseAnthropicList(null)).toEqual([]);
  });
  it("OpenAI : identifiants seulement", () => {
    expect(parseOpenAiList({ data: [{ id: "gpt-6-luna" }, { id: "gpt-6.1-terra" }, {}] }).map((m) => m.modelId)).toEqual(["gpt-6-luna", "gpt-6.1-terra"]);
  });
  it("Mistral : tableau nu ou {data}, alias, modèle archivé, modèle sans chat ignoré", () => {
    const rows = [{ id: "mistral-small-2603", aliases: ["mistral-small-latest"], max_context_length: 262144, capabilities: { completion_chat: true } }, { id: "old", archived: true }, { id: "embed", capabilities: { completion_chat: false } }];
    for (const doc of [rows, { data: rows }]) {
      const l = parseMistralList(doc);
      expect(l.map((m) => [m.modelId, m.lifecycle])).toEqual([["mistral-small-2603", "ACTIVE"], ["old", "RETIRED"]]);
      expect(l[0]).toMatchObject({ aliases: ["mistral-small-latest"], maxInputTokens: 262144 });
    }
  });
});

describe("disponibilité : mise à jour du catalogue", () => {
  it("un modèle du catalogue absent d'une liste complète passe en ABSENT, un modèle listé est mis à jour", () => {
    const up = applyListing("anthropic", parseAnthropicList({ data: [{ id: "claude-sonnet-5-5", lifecycle: "active", max_input_tokens: 1000000, max_tokens: 128000 }] }));
    expect(up.find((u) => u.modelId === "claude-sonnet-5-5")).toMatchObject({ lifecycle: "ACTIVE", seen: true });
    expect(up.find((u) => u.modelId === "claude-haiku-5-5")).toMatchObject({ lifecycle: "ABSENT", seen: false });
    expect(up.every((u) => ["claude-haiku-5-5", "claude-sonnet-5-5"].includes(u.modelId))).toBe(true);
  });
  it("Mistral : l'identifiant figé est retrouvé par l'alias déclaré par le fournisseur", () => {
    const up = applyListing("mistral", parseMistralList({ data: [{ id: "mistral-small-latest", aliases: ["mistral-small-2603"] }] }));
    expect(up).toEqual([expect.objectContaining({ modelId: "mistral-small-2603", lifecycle: "ACTIVE", seen: true })]);
  });
});

describe("disponibilité : un modèle est-il routable ?", () => {
  const row = { modelId: "claude-haiku-5-5", lifecycle: "ACTIVE" as const, retiresAt: null, isAlias: false };
  it("actif avec prix connu : oui", () => { expect(routableVerdict(row, true, NOW)).toEqual({ routable: true }); });
  it("sans prix connu : jamais routé", () => { expect(routableVerdict(row, false, NOW)).toEqual({ routable: false, reason: "sans_prix" }); });
  it("retiré, absent, jamais listé : exclus immédiatement", () => {
    expect(routableVerdict({ ...row, lifecycle: "RETIRED" }, true, NOW)).toMatchObject({ reason: "retire" });
    expect(routableVerdict({ ...row, lifecycle: "ABSENT" }, true, NOW)).toMatchObject({ reason: "absent" });
    expect(routableVerdict({ ...row, lifecycle: "UNKNOWN" }, true, NOW)).toMatchObject({ reason: "non_liste" });
  });
  it("alias mouvant : jamais routé", () => {
    expect(routableVerdict({ ...row, modelId: "mistral-small-latest" }, true, NOW)).toMatchObject({ reason: "alias" });
    expect(routableVerdict({ ...row, isAlias: true }, true, NOW)).toMatchObject({ reason: "alias" });
  });
  it(`déprécié : exclu ${DEPRECATION_MARGIN_DAYS} jours avant le retrait, routable avant`, () => {
    const dep = (days: number) => ({ ...row, lifecycle: "DEPRECATED" as const, retiresAt: new Date(+NOW + days * day) });
    expect(routableVerdict(dep(8), true, NOW)).toEqual({ routable: true });
    expect(routableVerdict(dep(7), true, NOW)).toMatchObject({ reason: "deprecie_bientot_retire" });
    expect(routableVerdict(dep(-2), true, NOW)).toMatchObject({ reason: "deprecie_bientot_retire" });
    expect(routableVerdict({ ...row, lifecycle: "DEPRECATED", retiresAt: null }, true, NOW)).toEqual({ routable: true });
  });
});

describe("coût réel d'un appel tracé", () => {
  const book = new Map([["claude-haiku-5-5", { snapshotId: "p1", price: { inputPerMtok: 0.1, outputPerMtok: 0.5, long: null } }], ["claude-sonnet-5-5", { snapshotId: "p2", price: { inputPerMtok: 2, outputPerMtok: 10, long: null } }]]);
  it("additionne chaque essai facturable au prix de son propre modèle (montée en gamme comprise)", () => {
    const r = costOfTried([{ model: "claude-haiku-5-5", outcome: "SCHEMA", inputTokens: 10_000, outputTokens: 1_000 }, { model: "claude-sonnet-5-5", outcome: "OK", inputTokens: 10_000, outputTokens: 1_000 }], book);
    expect(r.costUsd).toBeCloseTo(0.0015 + 0.03, 6);
    expect(r.snapshotId).toBe("p2");
  });
  it("une panne du fournisseur n'a pas de réponse donc pas de coût", () => {
    const r = costOfTried([{ model: "claude-haiku-5-5", outcome: "PROVIDER_ERROR" }, { model: "claude-sonnet-5-5", outcome: "OK", inputTokens: 1_000_000, outputTokens: 0 }], book);
    expect(r.costUsd).toBe(2);
  });
  it("prix inconnu ou jetons non déclarés : coût inconnu (null), pas un total partiel", () => {
    expect(costOfTried([{ model: "modele-inconnu", outcome: "OK", inputTokens: 5, outputTokens: 5 }], book).costUsd).toBeNull();
    expect(costOfTried([{ model: "claude-haiku-5-5", outcome: "OK" }], book).costUsd).toBeNull();
    expect(costOfTried([{ model: "claude-haiku-5-5", outcome: "OK", inputTokens: 5, outputTokens: 5 }, { model: "modele-inconnu", outcome: "OK", inputTokens: 5, outputTokens: 5 }], book).costUsd).toBeNull();
    expect(costOfTried([], book).costUsd).toBeNull();
    expect(costOfTried([{ model: "claude-haiku-5-5", outcome: "PROVIDER_ERROR" }], book).costUsd).toBeNull();
  });
});

describe("job de synchronisation : fréquence", () => {
  it("due si jamais lancée ou si la dernière passe a plus de l'intervalle ; jamais si désactivée (0)", () => {
    expect(syncDue(null, NOW, 24)).toBe(true);
    expect(syncDue(new Date(+NOW - 25 * 3600_000), NOW, 24)).toBe(true);
    expect(syncDue(new Date(+NOW - 23 * 3600_000), NOW, 24)).toBe(false);
    expect(syncDue(null, NOW, 0)).toBe(false);
  });
});
