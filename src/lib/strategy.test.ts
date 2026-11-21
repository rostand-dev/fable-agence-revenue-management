import { describe, expect, it } from "vitest";
import type { Strategy } from "./engine/types";
import { applyBuilderValues, builderValuesOf, diffStrategy, parseBuilderValues } from "./strategy";

const strat = (o: Partial<Strategy> = {}): Strategy => ({ basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 21000, minStay: 2, objective: "+20 % de CA", positioning: "Pro", maxDiscountStackPct: 20, maxPriceChangePct: 5, ...o });

describe("stratégie : comparaison et validation (US-023)", () => {
  it("aucun changement : rien ; les valeurs par défaut des garde-fous ne comptent pas comme un changement", () => {
    expect(diffStrategy(strat(), strat())).toEqual([]);
    expect(diffStrategy({ ...strat(), maxDiscountStackPct: undefined as any }, strat())).toEqual([]);
  });
  it("les changements sont en clair, inconnu = non renseigné", () => {
    const c = diffStrategy(strat(), strat({ minStay: 3, basePriceCents: 12000, objective: undefined, maxDiscountStackPct: 15.5 }));
    expect(c.map((x) => [x.key, x.from, x.to])).toEqual([["objective", "+20 % de CA", null], ["basePriceCents", "116,00 €", "120,00 €"], ["minStay", "2 nuits", "3 nuits"], ["maxDiscountStackPct", "20 %", "15,5 %"]]);
  });
  it("le Builder ne touche jamais aux prix", () => {
    const s = strat(), v = { ...builderValuesOf(s), maxPriceChangePct: 8, minStay: null };
    expect(applyBuilderValues(s, v)).toMatchObject({ basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 21000, minStay: null, maxPriceChangePct: 8 });
  });
  it("bornes : séjour 1–30 entier, remises 0–50, variation 1–30, textes limités ; absent = inchangé ; vide = inconnu", () => {
    const cur = builderValuesOf(strat());
    const ok = (raw: Record<string, unknown>) => { const r = parseBuilderValues(raw, cur); return r.ok ? r.value : r.error; };
    expect(ok({ minStay: "3", maxDiscountStackPct: "12,5" })).toMatchObject({ minStay: 3, maxDiscountStackPct: 12.5, maxPriceChangePct: 5, objective: "+20 % de CA" });
    expect(ok({ minStay: "" })).toMatchObject({ minStay: null });
    for (const [raw, msg] of [[{ minStay: "0" }, /séjour/], [{ minStay: "2,5" }, /séjour/], [{ minStay: "31" }, /séjour/], [{ maxDiscountStackPct: "51" }, /remises/], [{ maxDiscountStackPct: "" }, /remises/], [{ maxDiscountStackPct: "abc" }, /remises/], [{ maxPriceChangePct: "0" }, /variation/], [{ maxPriceChangePct: "31" }, /variation/], [{ objective: "x".repeat(161) }, /objectif/i], [{ positioning: "x".repeat(121) }, /positionnement/i]] as const) expect(ok(raw as any)).toMatch(msg);
  });
});
