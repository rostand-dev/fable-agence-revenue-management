import { describe, expect, it } from "vitest";
import { horizonSummary } from "./horizon";

const d = (date: string, state: "FREE" | "BOOKED" | "BLOCKED", priceCents: number | null = 10000) => ({ date, state, priceCents });
describe("horizonSummary", () => {
  it("compte les nuits par état ; les bloquées sont hors vente", () => {
    const s = horizonSummary([d("2026-12-01", "BOOKED"), d("2026-12-02", "BOOKED"), d("2026-12-03", "FREE"), d("2026-12-04", "BLOCKED"), d("2026-12-05", "FREE")], new Map());
    expect(s).toMatchObject({ nights: 5, booked: 2, blocked: 1, free: 2, sellable: 4, occupancy: 0.5, flagged: 0, vetoed: 0 });
  });
  it("aucune nuit vendable : occupation inconnue (null), jamais 0 %", () => {
    expect(horizonSummary([d("2026-12-01", "BLOCKED")], new Map()).occupancy).toBeNull();
    expect(horizonSummary([], new Map()).occupancy).toBeNull();
  });
  it("dossiers ouverts et vetos comptés sur les nuits non bloquées seulement", () => {
    const f = new Map([["2026-12-01", true], ["2026-12-02", false], ["2026-12-03", false]]);
    const s = horizonSummary([d("2026-12-01", "FREE"), d("2026-12-02", "BOOKED"), d("2026-12-03", "BLOCKED"), d("2026-12-04", "FREE")], f);
    expect(s.flagged).toBe(2); expect(s.vetoed).toBe(1);
  });
  it("prix libre inconnu compté à part, pas comme un prix nul", () => {
    const s = horizonSummary([d("2026-12-01", "FREE", null), d("2026-12-02", "FREE", 0), d("2026-12-03", "BOOKED", null)], new Map());
    expect(s.freeUnpriced).toBe(1);
  });
});
