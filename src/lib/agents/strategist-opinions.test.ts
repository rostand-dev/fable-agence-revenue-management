import { describe, expect, it } from "vitest";
import { deterministicOpinion, deterministicOpinions, factsHashOf, fromOpinionModel, opinionContext, opinionPrompt, opinionSchema, ownedOptions } from "./strategist-opinions";
import type { DetectedOpportunity } from "../engine/types";

const cand = (agent: string, label: string, verdict: "APPROVE" | "REJECT" | "NEEDS_HUMAN", extra: object = {}) => ({
  type: "PRICE_DATED", label, detail: "Prix daté sur 3 nuits", agent, target: { system: "PRICELABS" }, parameters: { delta: -8 }, nightsTouched: 3, priceChangePct: -8,
  current: null, proposed: null, expectedDeltaCents: 12000, hypothesis: "Hypothèse : 2 nuits supplémentaires vendues", rollbackPlan: "Retirer le prix daté sous 24 h", executionMode: "API_PRICELABS", risk: "LOW",
  audit: { verdict, rules: verdict === "APPROVE" ? [] : [{ code: "X", label: "x", outcome: verdict === "REJECT" ? "FAIL" : "WARN", detail: "Marge sous la cible" }] }, measurementWindowDays: 7, ...extra,
});
const o = {
  stayFrom: "2026-10-03", stayTo: "2026-10-09", signalText: "Occupation de 43 % contre 67 % pour le marché",
  candidates: [cand("pricing", "Baisse datée", "APPROVE"), cand("pricing", "Séjour minimum", "NEEDS_HUMAN", { expectedDeltaCents: 5000 }), cand("distribution", "Promotion Booking", "REJECT"), cand("direction", "Ne rien faire", "APPROVE")],
} as unknown as DetectedOpportunity;
const ctx = opinionContext(o, "pricing");
const schema = opinionSchema(ctx);
const issues = (v: unknown) => { const r = schema.safeParse(v); return r.success ? [] : r.error.issues.map((i) => i.message); };
const op = (option: string, stance: string, rationale = "Option simulée sur 3 nuits, validée par le moteur et son auditeur.") => ({ option, stance, rationale, watchpoints: [] });

describe("options des stratèges (US-072)", () => {
  it("chaque stratège ne reçoit que ses options, numérotées dans l'ordre", () => {
    expect(ownedOptions(o, "pricing").map((x) => [x.id, x.index])).toEqual([["O1", 0], ["O2", 1]]);
    expect(ownedOptions(o, "distribution").map((x) => [x.id, x.index])).toEqual([["O1", 2]]);
    expect(opinionPrompt(o, "distribution")).not.toContain("Baisse datée");
  });
  it("avis par règles : la position suit l'auditeur, la justification est l'hypothèse du moteur", () => {
    const d = deterministicOpinion(o, "pricing");
    expect(d.items.map((i) => i.stance)).toEqual(["FAVORABLE", "RESERVES"]);
    expect(d.items[0].rationale).toContain("Hypothèse");
    expect(deterministicOpinion(o, "distribution").items[0].stance).toBe("DEFAVORABLE");
    expect(Object.keys(deterministicOpinions(o)).sort()).toEqual(["distribution", "pricing"]);
  });
});

describe("contrôles des avis (US-072)", () => {
  it("un avis conforme passe", () => expect(issues({ opinions: [op("O1", "FAVORABLE"), op("O2", "RESERVES")] })).toEqual([]));
  it("refuse une option inconnue ou commentée deux fois", () => {
    expect(issues({ opinions: [op("O7", "RESERVES")] }).join()).toContain("O7");
    expect(issues({ opinions: [op("O1", "FAVORABLE"), op("O1", "RESERVES")] }).join()).toContain("deux fois");
  });
  it("jamais plus favorable que l'auditeur : une validation humaine reste au mieux avec réserves", () => {
    expect(issues({ opinions: [op("O2", "FAVORABLE")] }).join()).toContain("verdict de l'auditeur");
    expect(issues({ opinions: [op("O1", "FAVORABLE"), op("O2", "DEFAVORABLE")] })).toEqual([]);
    const d = opinionSchema(opinionContext(o, "distribution"));
    expect(d.safeParse({ opinions: [op("O1", "RESERVES")] }).success).toBe(false);
    expect(d.safeParse({ opinions: [op("O1", "DEFAVORABLE")] }).success).toBe(true);
  });
  it("refuse un chiffre absent des faits de l'option, ou emprunté à une autre option", () => {
    expect(issues({ opinions: [op("O1", "FAVORABLE", "Un gain de 450 € est attendu sur cette option simulée.")] }).join()).toContain("chiffre");
    expect(issues({ opinions: [op("O2", "RESERVES", "Un gain de +120 € est attendu sur cette option simulée.")] }).join()).toContain("chiffre");
  });
  it.each(["Il faudrait plutôt baisser davantage le prix.", "Nous recommandons d'ajouter une promotion.", "Voir https://exemple.fr pour cette option simulée."])("refuse : %s", (t) => {
    expect(issues({ opinions: [op("O1", "RESERVES", t)] }).length).toBeGreaterThan(0);
  });
  it("refuse un texte qui nomme une autre option", () => expect(issues({ opinions: [op("O1", "RESERVES", "Meilleure que O2 sur cette option simulée sur 3 nuits.")] }).join()).toContain("O2"));
  it("l'option du modèle est retrouvée par notre numérotation, l'empreinte dépend de la version du prompt", () => {
    const m = fromOpinionModel(o, "distribution", { opinions: [op("O1", "DEFAVORABLE", "Option rejetée par l'auditeur, simulée sur 3 nuits.")] } as never, { promptVersion: "v1" });
    expect(m.items[0].candidate).toBe(2);
    expect(factsHashOf(o, "pricing", "a")).not.toBe(factsHashOf(o, "pricing", "b"));
    expect(factsHashOf(o, "pricing", "a")).not.toBe(factsHashOf(o, "distribution", "a"));
  });
  it("chaque option du stratège doit être commentée", () => expect(issues({ opinions: [op("O1", "FAVORABLE")] }).join()).toContain("O2"));
  it("refuse les nombres en lettres et « ajouter » ; accepte « option recommandée »", () => {
    expect(issues({ opinions: [op("O1", "RESERVES", "Cent nuits simulées sur cette option, selon le moteur."), op("O2", "RESERVES")] }).join()).toContain("chiffres");
    expect(issues({ opinions: [op("O1", "RESERVES", "Il faudrait ajouter une promotion sur cette option simulée."), op("O2", "RESERVES")] }).join()).toContain("aucune autre action");
    expect(issues({ opinions: [op("O1", "FAVORABLE", "C'est l'option recommandée par le moteur, simulée sur 3 nuits."), op("O2", "RESERVES")] })).toEqual([]);
  });
  it("un montant en centimes dans les paramètres s'écrit en euros ; une date ISO ne cautionne aucun chiffre", () => {
    const oc = { ...o, candidates: [cand("pricing", "Prix daté", "APPROVE", { parameters: { nightlyCents: 12000, date: "2026-10-05" } })] } as unknown as DetectedOpportunity;
    const s2 = opinionSchema(opinionContext(oc, "pricing"));
    expect(s2.safeParse({ opinions: [op("O1", "FAVORABLE", "Le prix daté de 120 € est simulé sur cette option.")] }).success).toBe(true);
    expect(s2.safeParse({ opinions: [op("O1", "FAVORABLE", "Option simulée pour le 12 de ce mois, selon le moteur.")] }).success).toBe(false);
  });
  it("l'empreinte dépend de la position des options dans le dossier", () => {
    const moved = { ...o, candidates: [o.candidates[3], ...o.candidates.slice(0, 3)] } as unknown as DetectedOpportunity;
    expect(factsHashOf(moved, "pricing")).not.toBe(factsHashOf(o, "pricing"));
  });
});
