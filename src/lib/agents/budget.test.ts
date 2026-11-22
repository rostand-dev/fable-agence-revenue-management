import { describe, expect, it } from "vitest";
import { budgetDayStart, budgetLimits, checkBudget, DEFAULT_CALLS_PER_REVIEW, DEFAULT_DAILY_TOKENS } from "./budget";

describe("budgetLimits", () => {
  it("défauts quand rien n'est défini", () => expect(budgetLimits({})).toEqual({ callsPerReview: DEFAULT_CALLS_PER_REVIEW, dailyTokens: DEFAULT_DAILY_TOKENS }));
  it("lit des entiers, 0 compris (désactive)", () => expect(budgetLimits({ AGENT_MAX_CALLS_PER_REVIEW: " 5 ", AGENT_DAILY_TOKEN_BUDGET: "0" })).toEqual({ callsPerReview: 5, dailyTokens: 0 }));
  it.each(["", "abc", "-3", "2.5", "1e3", "999999999999"])("valeur invalide « %s » : retour au défaut", (v) => expect(budgetLimits({ AGENT_MAX_CALLS_PER_REVIEW: v, AGENT_DAILY_TOKEN_BUDGET: v })).toEqual({ callsPerReview: DEFAULT_CALLS_PER_REVIEW, dailyTokens: DEFAULT_DAILY_TOKENS }));
});

describe("checkBudget", () => {
  const limits = { callsPerReview: 2, dailyTokens: 1000 };
  it("permis sous les deux plafonds", () => expect(checkBudget({ limits, callsUsed: 1, tokensUsedToday: 999 })).toEqual({ ok: true }));
  it("plafond d'appels atteint", () => expect(checkBudget({ limits, callsUsed: 2, tokensUsedToday: 0 })).toEqual({ ok: false, reason: "BUDGET_CALLS" }));
  it("budget de jetons atteint", () => expect(checkBudget({ limits, callsUsed: 0, tokensUsedToday: 1000 })).toEqual({ ok: false, reason: "BUDGET_TOKENS" }));
  it("0 interdit tout appel", () => {
    expect(checkBudget({ limits: { callsPerReview: 0, dailyTokens: 10 }, callsUsed: 0, tokensUsedToday: 0 }).ok).toBe(false);
    expect(checkBudget({ limits: { callsPerReview: 5, dailyTokens: 0 }, callsUsed: 0, tokensUsedToday: 0 }).ok).toBe(false);
  });
});

describe("budgetDayStart", () => {
  it("début du jour UTC", () => expect(budgetDayStart(new Date("2026-11-23T23:59:59Z")).toISOString()).toBe("2026-11-23T00:00:00.000Z"));
});
