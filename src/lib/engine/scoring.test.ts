import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { buildDemo } from "./demo";
import { priorityScore, reviewProperty, type EngineInput } from "./detect";
import { PLAYBOOK_CODES } from "./playbooks";
import { DEFAULT_SCORING, resolveScoring, scoreOpportunity, scoringOverrides, validateScoringInput } from "./scoring";
import type { DetectedOpportunity } from "./types";

const TODAY = "2026-11-12";
function opps(): DetectedOpportunity[] {
  const p = buildDemo(TODAY).find((x) => x.key === "chatillon")!;
  const now = new Date(TODAY + "T07:00:00Z");
  const i: EngineInput = {
    today: TODAY, now, property: { id: "p", name: p.name, isDemo: true }, model: p.economics, strategy: p.strategy, days: p.days,
    resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })),
    promos: p.promos.map((x, k) => ({ id: "p" + k, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.fromOffset === null ? null : addDays(TODAY, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(TODAY, x.toOffset), verifiedAt: new Date(+now - x.verifiedDaysAgo * 86400000) })),
    capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
  };
  return reviewProperty(i).opportunities;
}
const withImpact = (o: DetectedOpportunity): DetectedOpportunity => ({ ...o, veto: false, urgency: 2, diagnosis: { ...o.diagnosis, confidence: 0.5 }, candidates: o.candidates.map((c) => ({ ...c, expectedDeltaCents: 20000, risk: "MEDIUM" as const, executionMode: "MANUAL_RUNBOOK" as const, type: "CHANNEL_PROMO" as const })), selected: 0 });

describe("score de priorité", () => {
  it("le réglage par défaut reproduit le score d'origine sur chaque dossier de démonstration", () => {
    const list = opps();
    expect(list.length).toBeGreaterThan(0);
    for (const o of list) expect(scoreOpportunity(o, DEFAULT_SCORING).score).toBe(priorityScore(o));
  });
  it("applique la formule du blueprint : gain × confiance × urgence × poids − coût − risque", () => {
    const o = withImpact(opps()[0]);
    // 200 € × 0,5 × 2 × 1 − 0 − 4 (risque moyen)
    expect(scoreOpportunity(o).score).toBe(196);
    const cfg = resolveScoring({ strategicWeight: { [o.playbook]: 1.5 }, executionCost: { MANUAL_RUNBOOK: 6 }, riskPenalty: { MEDIUM: 10 } });
    // 200 × 0,5 × 2 × 1,5 = 300 − 6 − 10
    expect(scoreOpportunity(o, cfg).score).toBe(284);
  });
  it("le détail du score rend la somme exacte", () => {
    const b = scoreOpportunity(withImpact(opps()[0]));
    expect(b.score).toBeCloseTo(b.impact * b.confidence * b.urgency * b.weight - b.executionCost - b.riskPenalty, 1);
  });
  it("un gain inconnu ou négatif ne vaut jamais plus que zéro, et le NO_ACTION n'a pas de coût d'exécution", () => {
    const o = withImpact(opps()[0]);
    const neg = { ...o, candidates: o.candidates.map((c) => ({ ...c, expectedDeltaCents: -5000 })) };
    expect(scoreOpportunity(neg).impact).toBe(0);
    const noAction = { ...o, candidates: o.candidates.map((c) => ({ ...c, type: "NO_ACTION" as const })) };
    expect(scoreOpportunity(noAction, resolveScoring({ executionCost: { MANUAL_RUNBOOK: 50 } })).executionCost).toBe(0);
  });
  it("un dossier sous veto remonte pour être traité, quels que soient les réglages", () => {
    const o = { ...withImpact(opps()[0]), veto: true };
    const cfg = resolveScoring({ strategicWeight: Object.fromEntries(PLAYBOOK_CODES.map((c) => [c, 0])) });
    expect(scoreOpportunity(o, cfg).score).toBeGreaterThan(9000);
  });
  it("un poids nul retire la valeur du classement sans jamais la rendre négative au-delà des pénalités", () => {
    const o = withImpact(opps()[0]);
    expect(scoreOpportunity(o, resolveScoring({ strategicWeight: { [o.playbook]: 0 } })).score).toBe(-4);
  });
});

describe("configuration du score", () => {
  it("une valeur absente, illisible ou hors bornes retombe sur le défaut, pas sur zéro", () => {
    const c = resolveScoring({ strategicWeight: { "PB-01": "abc", "PB-02": 99, "PB-03": -1, "PB-04": null }, riskPenalty: { HIGH: 5000 }, executionCost: "n'importe quoi" });
    expect(c.strategicWeight["PB-01"]).toBe(1);
    expect(c.strategicWeight["PB-02"]).toBe(1);
    expect(c.strategicWeight["PB-03"]).toBe(1);
    expect(c.strategicWeight["PB-04"]).toBe(1);
    expect(c.riskPenalty.HIGH).toBe(10);
    expect(c.executionCost.MANUAL_RUNBOOK).toBe(0);
    expect(resolveScoring(null)).toEqual(DEFAULT_SCORING);
    expect(resolveScoring("x")).toEqual(DEFAULT_SCORING);
  });
  it("accepte la virgule décimale française et les bornes exactes", () => {
    const c = resolveScoring({ strategicWeight: { "PB-01": "1,5", "PB-02": 0, "PB-03": 5 } });
    expect(c.strategicWeight["PB-01"]).toBe(1.5);
    expect(c.strategicWeight["PB-02"]).toBe(0);
    expect(c.strategicWeight["PB-03"]).toBe(5);
  });
  it("la saisie invalide est refusée en nommant le champ", () => {
    const r = validateScoringInput({ strategicWeight: { "PB-01": "9" } });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("Poids de PB-01") });
    expect(validateScoringInput({ riskPenalty: { LOW: "x" } })).toMatchObject({ ok: false });
    expect(validateScoringInput({ executionCost: { INTERNAL: "-3" } })).toMatchObject({ ok: false });
    expect(validateScoringInput({ strategicWeight: { "PB-01": "2" } })).toMatchObject({ ok: true });
  });
  it("seuls les écarts au défaut sont retenus ; le défaut complet ne laisse rien", () => {
    expect(scoringOverrides(DEFAULT_SCORING)).toEqual({});
    const c = resolveScoring({ strategicWeight: { "PB-02": 2 }, executionCost: { MANUAL_RUNBOOK: 3 } });
    expect(scoringOverrides(c)).toEqual({ strategicWeight: { "PB-02": 2 }, executionCost: { MANUAL_RUNBOOK: 3 } });
  });
});
