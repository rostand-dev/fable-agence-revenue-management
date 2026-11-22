import { describe, expect, it } from "vitest";
import { ACTION_STATES, allTransitions, assertTransition, canTransition, CYCLE, isTerminal, nextStates, TERMINAL_STATES } from "./stateMachine";

describe("machine à états de RevenueAction (US-065)", () => {
  it("chaque transition du graphe est permise et son retour arrière est refusé", () => {
    for (const [f, t] of allTransitions()) {
      expect(canTransition(f, t)).toBe(true);
      expect(() => assertTransition(f, t)).not.toThrow();
      expect(canTransition(t, f), `${t}→${f}`).toBe(false);
    }
  });
  it("aucune transition vers soi-même, aucun saut dans la chaîne principale", () => {
    for (const s of ACTION_STATES) expect(canTransition(s, s)).toBe(false);
    expect(canTransition("DRAFT", "APPROVED")).toBe(false);
    expect(canTransition("APPROVED", "EXECUTED")).toBe(false);
    expect(canTransition("EXECUTED", "MEASURING")).toBe(false);
  });
  it("les états terminaux n'ont aucune sortie", () => {
    expect(TERMINAL_STATES.length).toBeGreaterThan(0);
    for (const s of TERMINAL_STATES) { expect(isTerminal(s)).toBe(true); expect(nextStates(s)).toEqual([]); }
    for (const s of ["CLOSED", "ROLLED_BACK", "REJECTED", "CANCELLED", "EXPIRED"] as const) expect(isTerminal(s)).toBe(true);
  });
  it("tout état est atteignable depuis DRAFT", () => {
    const seen = new Set(["DRAFT"]); const q = ["DRAFT"];
    while (q.length) for (const n of nextStates(q.shift() as never)) if (!seen.has(n)) { seen.add(n); q.push(n); }
    for (const s of ACTION_STATES) expect(seen.has(s), s).toBe(true);
  });
  it("nextStates rend une copie : le graphe ne se modifie pas de l'extérieur", () => {
    nextStates("DRAFT").push("CLOSED");
    expect(canTransition("DRAFT", "CLOSED")).toBe(false);
  });
  it("la chaîne principale est permise de bout en bout", () => {
    const main = ["DRAFT", "SIMULATED", "AUDITED", "PENDING_APPROVAL", "APPROVED", "EXECUTING", "EXECUTED", "VERIFIED", "MEASURING", "CLOSED"] as const;
    for (let i = 0; i < main.length - 1; i++) expect(canTransition(main[i], main[i + 1]), `${main[i]}→${main[i + 1]}`).toBe(true);
    expect(CYCLE.length).toBe(8);
  });
});
