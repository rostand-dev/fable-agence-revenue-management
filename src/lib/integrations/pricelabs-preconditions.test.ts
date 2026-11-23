import { describe, expect, it } from "vitest";
import { BASE_DRIFT_TOLERANCE_PCT, checkPreconditions, GRID_DRIFT_TOLERANCE_PCT, type PreconditionInput } from "./pricelabs-preconditions";

const D1 = "2026-12-21", D2 = "2026-12-22";
const base = (over: Partial<PreconditionInput> = {}): PreconditionInput => ({
  plan: { kind: "LISTING_LIMITS", limits: { minCents: 9500 } }, type: "MIN_PRICE_CHANGE", parameters: { minPriceCents: 9500, previousMinPriceCents: 8300 },
  remote: { limits: { minCents: 8300, baseCents: 12000, maxCents: 25000 }, pushEnabled: true, prices: {}, overrides: [] },
  local: { prices: {}, baseCents: 12000 }, ...over,
});
const ov = (date: string, priceCents: number | null, minStay: number | null = null) => ({ date, priceCents, priceType: "fixed", minStay, raw: {} }) as any;

describe("préconditions d'écriture PriceLabs (US-091)", () => {
  it("état conforme à la simulation : rien à signaler", () => { expect(checkPreconditions(base())).toEqual([]); });
  it("synchronisation désactivée chez PriceLabs : refus ; inconnue : pas de refus", () => {
    expect(checkPreconditions(base({ remote: { ...base().remote, pushEnabled: false } }))[0]).toContain("synchronisation des prix est désactivée");
    expect(checkPreconditions(base({ remote: { ...base().remote, pushEnabled: null } }))).toEqual([]);
  });
  it("prix minimum : refus si PriceLabs n'a plus la valeur simulée, ou si elle est inconnue", () => {
    expect(checkPreconditions(base({ remote: { ...base().remote, limits: { minCents: 9000, baseCents: 12000, maxCents: 25000 } } }))[0]).toContain("90,00 €, pas 83,00 €");
    expect(checkPreconditions(base({ remote: { ...base().remote, limits: { minCents: null, baseCents: 12000, maxCents: 25000 } } }))[0]).toContain("inconnu");
  });
  it("prix minimum : sans valeur de départ dans l'action, repli sur la stratégie locale, sinon refus (jamais de contrôle silencieusement sauté)", () => {
    const noPrev = base({ parameters: { minPriceCents: 9500 } });
    expect(checkPreconditions(noPrev)[0]).toContain("n'indique pas le prix minimum de départ");
    expect(checkPreconditions({ ...noPrev, local: { ...noPrev.local, minCents: 8300 } })).toEqual([]);
    expect(checkPreconditions({ ...noPrev, local: { ...noPrev.local, minCents: 7000 } })[0]).toContain("83,00 €, pas 70,00 €");
  });
  it("prix minimum déjà à la valeur cible chez PriceLabs : état conforme, pas de refus (rejeu)", () => {
    expect(checkPreconditions(base({ remote: { ...base().remote, limits: { minCents: 9500, baseCents: 12000, maxCents: 25000 } } }))).toEqual([]);
  });
  it("contrôles croisés : une incohérence préexistante sans rapport avec le champ modifié ne bloque pas", () => {
    const r = base({ remote: { ...base().remote, limits: { minCents: 8300, baseCents: 30000, maxCents: 25000 } } }); // base > max déjà chez PriceLabs
    expect(checkPreconditions(r)).toEqual([]);
  });
  it("prix minimum : jamais au-dessus du maximum ni du prix de base", () => {
    const p = base({ plan: { kind: "LISTING_LIMITS", limits: { minCents: 30000 } }, parameters: { minPriceCents: 30000 } });
    expect(checkPreconditions(p).join("|")).toMatch(/dépasserait le prix maximum[\s\S]*dépasserait le prix de base|dépasserait le prix de base[\s\S]*dépasserait le prix maximum/);
  });
  it("prix de base : écart à la stratégie au-delà de la tolérance = refus ; dans la tolérance = ok", () => {
    const plan = { kind: "LISTING_LIMITS" as const, limits: { baseCents: 12600 } }, parameters = { basePriceCents: 12600 };
    const within = Math.round(12000 * (1 + (BASE_DRIFT_TOLERANCE_PCT - 0.5) / 100)), beyond = Math.round(12000 * (1 + (BASE_DRIFT_TOLERANCE_PCT + 1) / 100));
    expect(checkPreconditions(base({ plan, type: "BASE_PRICE_CHANGE", parameters, remote: { ...base().remote, limits: { minCents: 8300, baseCents: within, maxCents: 25000 } } }))).toEqual([]);
    expect(checkPreconditions(base({ plan, type: "BASE_PRICE_CHANGE", parameters, remote: { ...base().remote, limits: { minCents: 8300, baseCents: beyond, maxCents: 25000 } } }))[0]).toContain("s'écarte");
  });
  it("prix daté : un prix manuel déjà posé n'est pas écrasé ; le même prix est un rejeu inoffensif", () => {
    const plan = { kind: "OVERRIDES" as const, items: [{ date: D1, priceCents: 11000 }] }, parameters = { nightlyCents: 11000, restoresFloor: true, dates: [D1] };
    const mk = (o: any[]) => base({ plan, type: "PRICE_OVERRIDE", parameters, remote: { ...base().remote, overrides: o } });
    expect(checkPreconditions(mk([ov(D1, 15000)]))[0]).toContain("porte déjà un prix daté");
    expect(checkPreconditions(mk([ov(D1, 11000)]))).toEqual([]);
    expect(checkPreconditions(mk([ov(D2, 15000)]))).toEqual([]); // autre date : sans rapport
  });
  it("variation en % : la grille doit être celle de la simulation, à la tolérance près ; inconnue = refus", () => {
    const plan = { kind: "OVERRIDES" as const, items: [{ date: D1, priceCents: 10500 }] }, parameters = { changePct: 5, dates: [D1] };
    const mk = (rem: number | null) => base({ plan, type: "PRICE_OVERRIDE", parameters, local: { prices: { [D1]: 10000 }, baseCents: null }, remote: { ...base().remote, prices: { [D1]: rem } } });
    expect(checkPreconditions(mk(10000))).toEqual([]);
    expect(checkPreconditions(mk(Math.round(10000 * (1 + (GRID_DRIFT_TOLERANCE_PCT - 1) / 100))))).toEqual([]);
    expect(checkPreconditions(mk(11000))[0]).toContain("a changé depuis la simulation");
    expect(checkPreconditions(mk(null))[0]).toContain("inconnu chez PriceLabs");
  });
  it("prix daté identique mais portant un séjour minimum, ou posé en pourcentage : refus lisible", () => {
    const plan = { kind: "OVERRIDES" as const, items: [{ date: D1, priceCents: 11000 }] }, parameters = { nightlyCents: 11000, restoresFloor: true, dates: [D1] };
    const mk = (o: any[]) => base({ plan, type: "PRICE_OVERRIDE", parameters, remote: { ...base().remote, overrides: o } });
    expect(checkPreconditions(mk([ov(D1, 11000, 3)]))[0]).toContain("séjour minimum daté");
    expect(checkPreconditions(mk([{ ...ov(D1, 11000), priceType: "percent" }]))[0]).toContain("variation de 110 %");
  });
  it("variation en % : prix simulé figé dans l'action de préférence à la grille locale ; absent partout = refus ; seule une date qui dérive est signalée", () => {
    const plan = { kind: "OVERRIDES" as const, items: [{ date: D1, priceCents: 10500 }, { date: D2, priceCents: 10500 }] };
    const mk = (parameters: any, local: any, rem: any) => base({ plan, type: "PRICE_OVERRIDE", parameters: { changePct: 5, dates: [D1, D2], ...parameters }, local: { prices: local, baseCents: null }, remote: { ...base().remote, prices: rem } });
    // la grille locale a été resynchronisée depuis (= distant) mais la simulation figée montre l'ancien prix : dérive détectée
    const r = checkPreconditions(mk({ simulatedPrices: { [D1]: 10000, [D2]: 10000 } }, { [D1]: 11500, [D2]: 11500 }, { [D1]: 11500, [D2]: 10000 }));
    expect(r).toHaveLength(1); expect(r[0]).toContain(D1);
    expect(checkPreconditions(mk({}, {}, { [D1]: 10000, [D2]: 10000 })).filter((m) => m.includes("simulé"))).toHaveLength(2);
  });
  it("plusieurs raisons s'accumulent", () => {
    const r = checkPreconditions(base({ remote: { ...base().remote, pushEnabled: false, limits: { minCents: 9000, baseCents: 12000, maxCents: 25000 } } }));
    expect(r.length).toBeGreaterThanOrEqual(2);
  });
  it("prix daté hors des bornes réelles (minimum, maximum) : refus", () => {
    const plan = { kind: "OVERRIDES" as const, items: [{ date: D1, priceCents: 30000 }, { date: D2, priceCents: 5000 }] };
    const r = checkPreconditions(base({ plan, type: "PRICE_OVERRIDE", parameters: { nightlyCents: 30000, restoresFloor: true, dates: [D1, D2] } }));
    expect(r.some((m) => m.includes("dépasse le prix maximum"))).toBe(true);
    expect(r.some((m) => m.includes("passe sous le prix minimum"))).toBe(true);
  });
});
