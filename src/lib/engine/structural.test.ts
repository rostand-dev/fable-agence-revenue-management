import { describe, expect, it } from "vitest";
import { auditCandidate } from "./audit";
import { buildDemo } from "./demo";
import { COOLDOWN_GROUPS, cooldownGroupOf, PLAYBOOKS } from "./playbooks";
import { POLICY_RULES, policyViolations } from "./policy";
import { baseApprovalBlock, cumulativeBaseVariation, groupCooldownUntil, MAX_BASE_VARIATION_7D_PCT, recentBaseChanges, structuralHold, type BaseActionRow } from "./structural";
import type { Candidate } from "./types";

const TODAY = "2026-11-12";
const NOW = new Date(TODAY + "T08:00:00Z");
const daysAgo = (n: number) => new Date(+NOW - n * 86400000);
const act = (over: Partial<BaseActionRow> = {}): BaseActionRow => ({ type: "BASE_PRICE_CHANGE", status: "EXECUTED", approvedAt: daysAgo(2), createdAt: daysAgo(3), parameters: { changePct: 5 }, ...over });

describe("variations récentes du prix de base", () => {
  it("compte les actions de prix de base des 7 derniers jours, jamais les autres types ni les actions rejetées", () => {
    const r = recentBaseChanges([act(), act({ type: "PRICE_OVERRIDE" }), act({ status: "REJECTED" }), act({ status: "FAILED" }), act({ status: "CANCELLED" }), act({ approvedAt: daysAgo(8), createdAt: daysAgo(9) })], TODAY);
    expect(r).toEqual([{ at: "2026-11-10", changePct: 5 }]);
  });
  it("un retour arrière est un mouvement du prix de base : il compte encore dans le plafond", () => {
    expect(recentBaseChanges([act({ status: "ROLLED_BACK", parameters: { changePct: 12 } })], TODAY)).toEqual([{ at: "2026-11-10", changePct: 12 }]);
  });
  it("les jours se comptent à Paris : une approbation à 23:30 UTC tombe le lendemain, et la borne de 7 jours bascule avec elle", () => {
    // 2026-11-05 23:30 UTC = 2026-11-06 00:30 à Paris (hiver, UTC+1) : sixième jour précédent, encore dans la fenêtre du 12/11
    expect(recentBaseChanges([act({ approvedAt: new Date("2026-11-05T23:30:00Z") })], TODAY)).toEqual([{ at: "2026-11-06", changePct: 5 }]);
    // 2026-11-05 22:30 UTC = 23:30 le 05/11 à Paris : septième jour précédent, hors fenêtre
    expect(recentBaseChanges([act({ approvedAt: new Date("2026-11-05T22:30:00Z") })], TODAY)).toEqual([]);
  });
  it("la fenêtre de 7 jours inclut aujourd'hui et le sixième jour précédent", () => {
    expect(recentBaseChanges([act({ approvedAt: daysAgo(6) })], TODAY)).toHaveLength(1);
    expect(recentBaseChanges([act({ approvedAt: daysAgo(7) })], TODAY)).toHaveLength(0);
  });
  it("une action clôturée compte encore dans les 7 jours ; sans date d'approbation, la création sert de repli", () => {
    expect(recentBaseChanges([act({ status: "CLOSED" })], TODAY)).toHaveLength(1);
    expect(recentBaseChanges([act({ approvedAt: null, createdAt: daysAgo(1) })], TODAY)).toHaveLength(1);
  });
  it("une variation inconnue compte pour le plafond entier : un doute ne libère pas le levier", () => {
    expect(recentBaseChanges([act({ parameters: {} })], TODAY)[0].changePct).toBe(MAX_BASE_VARIATION_7D_PCT);
    expect(recentBaseChanges([act({ parameters: null })], TODAY)[0].changePct).toBe(MAX_BASE_VARIATION_7D_PCT);
  });
  it("le cumul additionne les valeurs absolues : une hausse puis une baisse ne s'annulent pas", () => {
    expect(cumulativeBaseVariation([{ at: TODAY, changePct: 10 }], -5)).toBe(15);
    expect(cumulativeBaseVariation([], 5)).toBe(5);
  });
});

describe("contrôle à l'approbation", () => {
  it("refuse une seconde modification du prix de base tant qu'une première est en observation", () => {
    expect(baseApprovalBlock([act({ status: "MEASURING" })], 5, TODAY)).toContain("déjà en cours");
  });
  it("refuse un cumul au-delà de 15 % sur 7 jours, accepte juste en dessous", () => {
    expect(baseApprovalBlock([act({ status: "CLOSED", parameters: { changePct: 10 } })], 5, TODAY)).toBeNull();
    expect(baseApprovalBlock([act({ status: "CLOSED", parameters: { changePct: 10 } })], 6, TODAY)).toContain("plafond de 15 %");
  });
  it("laisse passer quand rien n'est en cours", () => {
    expect(baseApprovalBlock([], 5, TODAY)).toBeNull();
  });
});

describe("verrou structurant", () => {
  it("n'existe que tant qu'une action de prix de base est approuvée, écrite, vérifiée ou en mesure", () => {
    expect(structuralHold([])).toBeNull();
    for (const status of ["APPROVED", "EXECUTING", "EXECUTED", "VERIFIED", "MEASURING"]) expect(structuralHold([act({ status })]), status).toMatchObject({ reason: "ACTION_ACTIVE" });
    for (const status of ["CLOSED", "REJECTED", "ROLLED_BACK", "FAILED", "CANCELLED", "EXPIRED", "DRAFT"]) expect(structuralHold([act({ status })]), status).toBeNull();
    expect(structuralHold([act({ type: "PRICE_OVERRIDE" })])).toBeNull();
  });
  it("donne la date de la plus ancienne action en cours", () => {
    expect(structuralHold([act({ approvedAt: daysAgo(1) }), act({ approvedAt: daysAgo(4) })])?.since).toBe("2026-11-08");
  });
});

describe("groupe de repos PB-02, PB-11, PB-12", () => {
  it("regroupe les trois playbooks du prix de base et aucun autre", () => {
    expect(COOLDOWN_GROUPS).toEqual([["PB-02", "PB-11", "PB-12"]]);
    expect(cooldownGroupOf("PB-11")).toContain("PB-12");
    expect(cooldownGroupOf("PB-01")).toBeNull();
  });
  it("une approbation sur PB-02 met PB-11 et PB-12 au repos, pour la durée de PB-02", () => {
    const decided = [{ playbook: "PB-02", status: "DECIDED", decision: "APPROVED", createdAt: daysAgo(30), decidedAt: daysAgo(5) }];
    const until = groupCooldownUntil(decided, "PB-12", NOW);
    expect(until).toBe("2026-11-28"); // 5 jours déjà écoulés sur les 21 de PB-02
    expect(groupCooldownUntil(decided, "PB-11", NOW)).toBe(until);
    expect(groupCooldownUntil(decided, "PB-01", NOW)).toBeNull();
  });
  it("le même playbook garde son propre repos (clé de dédoublonnage) : il ne se bloque pas lui-même ici", () => {
    expect(groupCooldownUntil([{ playbook: "PB-02", status: "DECIDED", decision: "APPROVED", createdAt: daysAgo(3), decidedAt: daysAgo(1) }], "PB-02", NOW)).toBeNull();
  });
  it("le repos prend fin ; un dossier non tranché ne met rien au repos", () => {
    expect(groupCooldownUntil([{ playbook: "PB-02", status: "DECIDED", decision: "APPROVED", createdAt: daysAgo(60), decidedAt: daysAgo(PLAYBOOKS["PB-02"].cooldownDays) }], "PB-12", NOW)).toBeNull();
    expect(groupCooldownUntil([{ playbook: "PB-02", status: "OPEN", createdAt: daysAgo(1) }, { playbook: "PB-02", status: "EXPIRED", createdAt: daysAgo(1) }], "PB-12", NOW)).toBeNull();
  });
  it("un refus, une inaction ou une approbation en observation ne met pas le groupe au repos", () => {
    for (const decision of ["REJECTED", "NO_ACTION", "APPROVED_SHADOW", null]) expect(groupCooldownUntil([{ playbook: "PB-11", status: "DECIDED", decision, createdAt: daysAgo(3), decidedAt: daysAgo(1) }], "PB-12", NOW), String(decision)).toBeNull();
  });
  it("garde la fin de repos la plus lointaine quand plusieurs décisions comptent", () => {
    const rows = [
      { playbook: "PB-02", status: "DECIDED", decision: "APPROVED", createdAt: daysAgo(30), decidedAt: daysAgo(10) },
      { playbook: "PB-11", status: "DECIDED", decision: "APPROVED", createdAt: daysAgo(30), decidedAt: daysAgo(1) },
    ];
    expect(groupCooldownUntil(rows, "PB-12", NOW)).toBe("2026-12-02"); // PB-11 : 21 jours depuis hier (11/11)
  });
});

describe("règles d'audit STRUCTURAL_LOCK et MAX_VARIATION_7D", () => {
  const base = buildDemo(TODAY).find((x) => x.key === "chatillon")!;
  const cand = (changePct: number): Omit<Candidate, "audit"> => ({
    type: "BASE_PRICE_CHANGE", label: "Relever le prix de base", detail: "", agent: "pricing", target: { system: "PRICELABS" },
    parameters: { dates: ["2026-12-01"], changePct, basePriceCents: 12000 }, nightsTouched: 1, priceChangePct: changePct,
    current: null, proposed: null, expectedDeltaCents: 1000, hypothesis: "", rollbackPlan: "Rétablir le prix précédent", executionMode: "API_PRICELABS", risk: "HIGH", measurementWindowDays: 14,
  });
  const ctx = (over = {}) => ({ model: base.economics, strategy: base.strategy, stalePromoChannels: [], conflict: false, capabilities: { "pricelabs.write": true }, demo: false, promos: [], window: { from: "2026-12-01", to: "2026-12-02" }, ...over });
  const outcome = (v: ReturnType<typeof auditCandidate>, code: string) => v.rules.find((r) => r.code === code)?.outcome;

  it("sans action en cours ni variation récente, les deux règles passent", () => {
    const v = auditCandidate(cand(5), ctx());
    expect(outcome(v, "STRUCTURAL_LOCK")).toBe("PASS");
    expect(outcome(v, "MAX_VARIATION_7D")).toBe("PASS");
    expect(policyViolations(v.rules)).toEqual([]);
  });
  it("une modification du prix de base déjà en cours est un veto nommé", () => {
    const v = auditCandidate(cand(5), ctx({ structuralHold: { reason: "ACTION_ACTIVE", since: "2026-11-09" } }));
    expect(v.verdict).toBe("REJECT");
    expect(v.vetoCodes).toContain("STRUCTURAL_LOCK");
    expect(v.rules.find((r) => r.code === "STRUCTURAL_LOCK")?.detail).toContain("09/11/2026");
  });
  it("le plafond de 15 % sur 7 jours se juge sur le cumul : 10 % déjà approuvés + 5 % passent, + 6 % sont rejetés", () => {
    const recent = [{ at: "2026-11-10", changePct: 10 }];
    expect(outcome(auditCandidate(cand(5), ctx({ recentBaseChanges: recent })), "MAX_VARIATION_7D")).toBe("PASS");
    const over = auditCandidate(cand(6), ctx({ recentBaseChanges: recent }));
    expect(outcome(over, "MAX_VARIATION_7D")).toBe("FAIL");
    expect(over.vetoCodes).toContain("MAX_VARIATION_7D");
  });
  it("une baisse compte comme une hausse dans le plafond", () => {
    expect(outcome(auditCandidate(cand(-8), ctx({ recentBaseChanges: [{ at: "2026-11-10", changePct: 8 }] })), "MAX_VARIATION_7D")).toBe("FAIL");
  });
  it("les autres types d'action ne sont pas concernés", () => {
    const o = { ...cand(0), type: "PRICE_OVERRIDE" as const, priceChangePct: null, parameters: { dates: ["2026-12-01"], nightlyCents: 12000 } };
    const v = auditCandidate(o, ctx({ structuralHold: { reason: "ACTION_ACTIVE", since: null }, recentBaseChanges: [{ at: "2026-11-10", changePct: 15 }] }));
    expect(v.rules.some((r) => r.code === "STRUCTURAL_LOCK" || r.code === "MAX_VARIATION_7D")).toBe(false);
  });
  it("les deux règles sont des vetos au registre et sont déclarées par PB-02, PB-11 et PB-12", () => {
    expect(POLICY_RULES.STRUCTURAL_LOCK.onFail).toBe("VETO");
    expect(POLICY_RULES.MAX_VARIATION_7D.onFail).toBe("VETO");
    for (const pb of ["PB-02", "PB-11", "PB-12"] as const) expect(PLAYBOOKS[pb].vetoRules).toEqual(expect.arrayContaining(["STRUCTURAL_LOCK", "MAX_VARIATION_7D"]));
  });
});
