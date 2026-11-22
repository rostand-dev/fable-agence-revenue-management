import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { auditCandidate } from "./audit";
import { buildDemo } from "./demo";
import { reviewProperty, type EngineInput } from "./detect";
import { PLAYBOOKS } from "./playbooks";
import { explainVerdict, policyCodes, policyViolations, POLICY_CODES, POLICY_RULES, verdictOf } from "./policy";
import type { AuditRule, AuditVerdict, Candidate } from "./types";

const rule = (code: string, outcome: AuditRule["outcome"]): AuditRule => ({ code, label: code, outcome, detail: "" });

describe("verdict", () => {
  it("un échec rejette, une alerte demande un humain, sinon conforme", () => {
    expect(verdictOf([rule("HARD_FLOOR", "PASS"), rule("SCOPE", "PASS")])).toBe("APPROVE");
    expect(verdictOf([rule("HARD_FLOOR", "PASS"), rule("SCOPE", "WARN")])).toBe("NEEDS_HUMAN");
    expect(verdictOf([rule("SCOPE", "WARN"), rule("HARD_FLOOR", "FAIL")])).toBe("REJECT");
    expect(verdictOf([])).toBe("APPROVE");
  });
  it("sépare les codes de veto et de validation humaine", () => {
    const v: AuditVerdict = { verdict: "REJECT", rules: [rule("HARD_FLOOR", "FAIL"), rule("SCOPE", "WARN"), rule("ROLLBACK", "PASS")] };
    expect(policyCodes(v)).toEqual({ veto: ["HARD_FLOOR"], human: ["SCOPE"] });
  });
  it("explique le verdict en français, avec le nom de chaque règle", () => {
    expect(explainVerdict({ verdict: "REJECT", rules: [rule("HARD_FLOOR", "FAIL"), rule("CONFLICT", "FAIL")] })).toBe("Rejetée : Plancher économique absolu, Conflit avec une action en cours.");
    expect(explainVerdict({ verdict: "NEEDS_HUMAN", rules: [rule("SCOPE", "WARN")] })).toContain("Portée en nuits");
    expect(explainVerdict({ verdict: "APPROVE", rules: [] })).toBe("Conforme à toutes les règles.");
  });
});

describe("registre des codes", () => {
  it("chaque règle est décrite : libellé, contrôle, seuil, référence au blueprint", () => {
    for (const c of POLICY_CODES) {
      const r = POLICY_RULES[c];
      expect(r.code).toBe(c);
      for (const f of [r.label, r.checks, r.threshold, r.ref]) expect(f.length, c).toBeGreaterThan(2);
      expect(r.onFail !== null || r.onWarn !== null, `${c} ne produit aucun résultat`).toBe(true);
    }
  });
  it("les règles de veto déclarées par les playbooks existent toutes au registre", () => {
    for (const p of Object.values(PLAYBOOKS)) for (const v of p.vetoRules) expect(POLICY_RULES[v], `${p.code} → ${v}`).toBeTruthy();
  });
  it("un résultat que la règle ne déclare pas est signalé comme défaut du moteur", () => {
    expect(policyViolations([rule("STRATEGY_FLOOR", "FAIL")])).toHaveLength(1);
    expect(policyViolations([rule("DISCOUNT_STACK", "WARN")])).toHaveLength(1);
    expect(policyViolations([rule("INCONNUE", "PASS")])).toEqual(["règle INCONNUE absente du registre des codes de veto"]);
    expect(policyViolations([rule("HARD_FLOOR", "FAIL"), rule("SCOPE", "WARN"), rule("CONFLICT", "PASS")])).toEqual([]);
  });
});

const cand = (over: Partial<Candidate> = {}): Omit<Candidate, "audit"> => ({
  type: "PRICE_OVERRIDE", label: "x", detail: "", agent: "pricing", target: { system: "PRICELABS" }, parameters: { dates: ["2026-12-01"], nightlyCents: 12000 }, nightsTouched: 1, priceChangePct: null,
  current: null, proposed: null, expectedDeltaCents: 1000, hypothesis: "", rollbackPlan: "retirer", executionMode: "API_PRICELABS", risk: "LOW", measurementWindowDays: 7, ...over,
});
const base = buildDemo("2026-11-12").find((x) => x.key === "chatillon")!;
const ctx = (over = {}) => ({ model: base.economics, strategy: base.strategy, stalePromoChannels: [], conflict: false, capabilities: { "pricelabs.write": true }, demo: false, promos: [], window: { from: "2026-12-01", to: "2026-12-02" }, ...over });

describe("l'auditeur applique le registre", () => {
  it("un conflit, un retour arrière absent ou une écriture impossible sont des vetos nommés", () => {
    const v = auditCandidate(cand({ rollbackPlan: "" }), ctx({ conflict: true, capabilities: { "pricelabs.write": false } }));
    expect(v.verdict).toBe("REJECT");
    expect(v.vetoCodes).toEqual(expect.arrayContaining(["CONFLICT", "ROLLBACK", "CAPABILITY"]));
    expect(policyViolations(v.rules)).toEqual([]);
  });
  it("une baisse de prix minimum demande la validation du propriétaire (MIN_PRICE_DOWN)", () => {
    const v = auditCandidate(cand({ type: "MIN_PRICE_CHANGE", parameters: { minPriceCents: 6000, previousMinPriceCents: 7000 }, nightsTouched: 0, priceChangePct: -14, target: { system: "PRICELABS" } }), ctx());
    expect(v.humanCodes).toContain("MIN_PRICE_DOWN");
  });
  it("une hausse de prix minimum n'appelle pas MIN_PRICE_DOWN", () => {
    const v = auditCandidate(cand({ type: "MIN_PRICE_CHANGE", parameters: { minPriceCents: 8000, previousMinPriceCents: 7000 }, nightsTouched: 0, priceChangePct: 14, target: { system: "PRICELABS" } }), ctx());
    expect(v.rules.map((r) => r.code)).not.toContain("MIN_PRICE_DOWN");
  });
  it("une variation au-delà de 15 % est un veto, entre la limite et 15 % une validation humaine", () => {
    const max = base.strategy.maxPriceChangePct;
    expect(auditCandidate(cand({ priceChangePct: 16 }), ctx()).vetoCodes).toContain("MAX_VARIATION");
    expect(auditCandidate(cand({ priceChangePct: Math.min(15, max + 2) }), ctx()).humanCodes).toContain("MAX_VARIATION");
  });
  it("le plancher absolu est un veto, jamais une simple alerte", () => {
    const v = auditCandidate(cand({ priceChangePct: null, current: null, proposed: { channel: "BOOKING", nights: 2, publishedNightlyCents: 3000, soldNightlyCents: 3000, cumulativeDiscountPct: 0, grossRoomCents: 6000, netRoomCents: 4000, contributionCents: 0, contributionPerNightCents: 0, netAdrCents: 2000, steps: [] } }), ctx());
    expect(v.vetoCodes).toContain("HARD_FLOOR");
    expect(v.verdict).toBe("REJECT");
  });
});

describe("le moteur n'émet que des règles du registre", () => {
  it("sur toutes les options de revue, avec et sans écriture", () => {
    let total = 0; const codes = new Set<string>();
    for (const day of ["2026-11-12", "2026-03-15", "2026-07-10"]) for (const key of ["chatillon", "evry"]) for (const isDemo of [true, false]) {
      const p = buildDemo(day).find((x) => x.key === key)!; const now = new Date(day + "T07:00:00Z");
      const i: EngineInput = {
        today: day, now, property: { id: "p", name: p.name, isDemo }, model: p.economics, strategy: p.strategy, days: p.days, resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })),
        promos: p.promos.map((x, k) => ({ id: "p" + k, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.fromOffset === null ? null : addDays(day, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(day, x.toOffset), verifiedAt: new Date(+now - x.verifiedDaysAgo * 86400000) })),
        capabilities: capabilityFlags({ isDemo, killSwitch: {} }), activeRanges: [], markups: isDemo ? undefined : { AIRBNB: 23, BOOKING: 0 },
      };
      for (const o of reviewProperty(i).opportunities) for (const c of o.candidates) {
        total++; for (const r of c.audit.rules) codes.add(r.code);
        expect(policyViolations(c.audit.rules), `${o.playbook} ${c.type}`).toEqual([]);
        expect(c.audit.verdict).toBe(verdictOf(c.audit.rules));
        expect(c.audit.vetoCodes).toEqual(policyCodes(c.audit).veto);
      }
    }
    expect(total).toBeGreaterThan(20);
    for (const must of ["HARD_FLOOR", "SCOPE", "CONFLICT", "ROLLBACK", "CAPABILITY"]) expect([...codes], must).toContain(must);
  });
});
