import { describe, expect, it } from "vitest";
import { UnknownEconomics, emptyEconomics } from "./economics";
import { simulate, type SimInput } from "./simulator";
import type { EconomicModel } from "./types";
import { auditCandidate } from "./audit";

const base = (over: Partial<EconomicModel> = {}): EconomicModel => ({ ...emptyEconomics(), cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } }, ...over });
const input = (over: Partial<SimInput> = {}): SimInput => ({ model: base(), channel: "AIRBNB", nights: 2, stayFrom: "2026-03-10", publishedNightlyCents: 10000, maxDiscountStackPct: 30, ...over });
const SUMMER = { id: "ete", label: "Été", from: "07-01", to: "08-31", strategyContributionPerNightCents: 6000 };

describe("simulateur explicable (US-053)", () => {
  it("cascade calculée à la main : 2 nuits à 100 €, Airbnb 15 %, sans remise", () => {
    const s = simulate(input());
    // 20000 − commission 3000 = 17000 ; coût de séjour 4000 + 1000 − 5000×0,85 = 750 ; variables 2×500 = 1000 ; contribution 15250
    expect(s.result).toMatchObject({ grossRoomCents: 20000, netRoomCents: 17000, contributionCents: 15250, contributionPerNightCents: 7625, soldNightlyCents: 10000 });
    expect(s.steps.map((x) => x.key)).toEqual(["published", "gross", "commission", "net", "stay", "variable", "contribution"]);
    expect(s.reconciles).toBe(true);
    expect(s.steps.every((x) => x.explanation.length > 10)).toBe(true);
    expect(s.verdict).toBe("OK");
  });
  it("remises appliquées l'une après l'autre : 10 % de durée puis 10 % de promotion = 19 %, et la cascade se referme", () => {
    const s = simulate(input({ losDiscountPct: 10, promos: [{ kind: "CUSTOM", label: "Promo", discountPct: 10 }] }));
    // 20000 − 2000 = 18000 ; −1800 = 16200 ; commission 2430 ; net 13770 ; contribution 13770 − 750 − 1000 = 12020
    expect(s.result).toMatchObject({ grossRoomCents: 16200, netRoomCents: 13770, contributionCents: 12020 });
    expect(s.result.cumulativeDiscountPct).toBeCloseTo(19, 10);
    expect(s.reconciles).toBe(true);
    expect(s.steps.filter((x) => x.key === "promo")[1].explanation).toContain("montant restant");
  });
  it("planchers calculés à la main : absolu 45,59 €, stratégique de base 57,36 €", () => {
    const s = simulate(input());
    expect(s.floors).toMatchObject({ hardCents: 4559, strategyCents: 5736, season: null });
  });
  it("verdict : sous le plancher stratégique = WARN ; sous le plancher absolu = REJECT ; au-delà du plafond de cumul = REJECT", () => {
    expect(simulate(input({ publishedNightlyCents: 5000 })).verdict).toBe("WARN");
    const low = simulate(input({ publishedNightlyCents: 4000 }));
    expect(low.verdict).toBe("REJECT");
    expect(low.reasons.find((r) => r.code === "HARD_FLOOR")?.outcome).toBe("FAIL");
    expect(simulate(input({ publishedNightlyCents: 20000, promos: [{ kind: "CUSTOM", label: "a", discountPct: 20 }, { kind: "LOS", label: "b", discountPct: 20 }], maxDiscountStackPct: 30 })).verdict).toBe("REJECT");
  });
  it("le plancher stratégique suit la saison du séjour ; le plancher absolu ne bouge pas", () => {
    const m = base({ seasons: [SUMMER] });
    const off = simulate(input({ model: m, publishedNightlyCents: 7000 }));
    const on = simulate(input({ model: m, publishedNightlyCents: 7000, stayFrom: "2026-07-10" }));
    expect(off.verdict).toBe("OK"); expect(off.floors.strategyCents).toBe(5736);
    expect(on.verdict).toBe("WARN"); expect(on.floors).toMatchObject({ strategyCents: 8089, hardCents: 4559 });
    expect(on.floors.season?.label).toBe("Été");
    expect(on.reasons.find((r) => r.code === "STRATEGY_FLOOR")?.detail).toContain("saison « Été »");
    // un séjour qui chevauche la saison est jugé sur le plancher le plus exigeant
    const straddle = simulate(input({ model: m, stayFrom: "2026-06-30", publishedNightlyCents: 7000 }));
    expect(straddle.floors.strategyCents).toBe(8089);
    expect(straddle.floors.season?.id).toBe("ete"); // la saison affichée est celle qui fixe le plancher
    expect(straddle.reasons.find((r) => r.code === "STRATEGY_FLOOR")?.detail).toContain("saison « Été »");
  });
  it("règle de cumul inconnue (Booking : Genius + Tarif mobile) : NEEDS_HUMAN, jamais deviné ; un rejet l'emporte", () => {
    const promos = [{ kind: "GENIUS", label: "Genius", discountPct: 10 }, { kind: "MOBILE", label: "Mobile", discountPct: 5 }];
    const s = simulate(input({ channel: "BOOKING", publishedNightlyCents: 15000, promos }));
    expect(s.verdict).toBe("NEEDS_HUMAN");
    expect(s.stacking.needsHuman).toBe(true);
    expect(s.reasons.find((r) => r.code === "STACK_RULES")?.detail).toContain("Règle de cumul inconnue");
    expect(simulate(input({ channel: "BOOKING", publishedNightlyCents: 3000, promos })).verdict).toBe("REJECT");
  });
  it("règle documentée (Airbnb : durée + personnalisée = une seule s'applique) : pas de décision humaine ; type absent du registre : inconnue", () => {
    const known = simulate(input({ losDiscountPct: 5, promos: [{ kind: "CUSTOM", label: "Promo", discountPct: 5 }] }));
    expect(known.stacking.needsHuman).toBe(false);
    expect(known.verdict).toBe("OK");
    expect(simulate(input({ promos: [{ kind: "INVENTE", label: "x", discountPct: 5 }, { kind: "CUSTOM", label: "y", discountPct: 5 }] })).verdict).toBe("NEEDS_HUMAN");
  });
  it("type de promotion absent du registre, même seul : NEEDS_HUMAN (inconnu n'est pas OK)", () => {
    expect(simulate(input({ promos: [{ kind: "INVENTE", label: "x", discountPct: 5 }] })).verdict).toBe("NEEDS_HUMAN");
  });
  it("règle exclusive : la cascade les cumule par prudence et le dit", () => {
    const s = simulate(input({ losDiscountPct: 5, promos: [{ kind: "CUSTOM", label: "Promo", discountPct: 5 }] }));
    expect(s.reasons.find((r) => r.code === "STACK_RULES")?.detail).toContain("par prudence");
  });
  it("explications : les montants cités sont ceux des étapes", () => {
    const s = simulate(input({ losDiscountPct: 10 }));
    const fr = (c: number) => (c / 100).toFixed(2).replace(".", ",");
    expect(s.steps.find((x) => x.key === "commission")!.explanation).toContain("15 %");
    expect(s.steps.find((x) => x.key === "promo")!.explanation).toMatch(new RegExp(fr(2000)));
    // ménage 40 € + linge 10 € − (50 € facturés, soit 42,50 € nets) = 7,50 €
    const stay = s.steps.find((x) => x.key === "stay")!.explanation;
    expect(stay).toContain("42,50"); expect(stay).toContain("7,50");
  });
  it("seuil du plafond de cumul : un cumul égal au plafond n'est pas rejeté (tolérance flottante)", () => {
    const s = simulate(input({ losDiscountPct: 10, promos: [{ kind: "CUSTOM", label: "p", discountPct: 10 }], maxDiscountStackPct: 19 }));
    expect(s.reasons.find((r) => r.code === "DISCOUNT_STACK")?.outcome).toBe("PASS");
  });
  it("registre périmé : NEEDS_HUMAN même sans promotion", () => { expect(simulate(input({ registryStale: true })).verdict).toBe("NEEDS_HUMAN"); });
  it("modèle incomplet : erreur explicite, jamais de chiffre inventé", () => { expect(() => simulate(input({ model: base({ cleaningCostCents: null }) }))).toThrow(UnknownEconomics); });
  it("ménage plus rentable que son coût : la marge est expliquée et la cascade se referme", () => {
    const s = simulate(input({ model: base({ cleaningFeeChargedCents: 9000 }) }));
    expect(s.steps.find((x) => x.key === "stay")!.label).toBe("Marge sur le ménage");
    expect(s.reconciles).toBe(true);
  });
  it("invariant sur 200 entrées pseudo-aléatoires reproductibles : la cascade se referme toujours au centime", () => {
    let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 200; n++) {
      const promos = Array.from({ length: Math.floor(rnd() * 3) }, (_, k) => ({ kind: "CUSTOM", label: `p${k}`, discountPct: Math.round(rnd() * 400) / 10 + 0.1 }));
      const s = simulate(input({ channel: rnd() < 0.5 ? "AIRBNB" : "BOOKING", nights: 1 + Math.floor(rnd() * 28), publishedNightlyCents: 1000 + Math.floor(rnd() * 40000), losDiscountPct: rnd() < 0.5 ? Math.round(rnd() * 200) / 10 + 0.1 : undefined, promos }));
      expect(s.reconciles).toBe(true);
    }
  });
});

describe("plancher saisonnier : bornes et non-régression", () => {
  it("sans saison, identique au plancher de base pour toute fenêtre (vide, un jour, longue)", async () => {
    const { strategyFloorCents } = await import("./economics");
    const { strategyFloorWindow } = await import("./seasons");
    const m = base();
    for (const [from, to] of [["2026-03-10", undefined], ["2026-03-10", "2026-03-10"], ["2026-03-10", "2026-03-11"], ["2026-03-10", "2026-06-01"]] as const)
      for (const n of [1, 2, 7, 28]) expect(strategyFloorWindow(m, "AIRBNB", n, from, to).floor).toBe(strategyFloorCents(m, "AIRBNB", n));
  });
  it("date extrême : jamais -Infinity ; fenêtre de plus de 400 nuits : erreur plutôt qu'un plancher sous-estimé", async () => {
    const { strategyFloorWindow } = await import("./seasons");
    const m = base({ seasons: [SUMMER] });
    expect(Number.isFinite(strategyFloorWindow(m, "AIRBNB", 5, "2099-12-30").floor)).toBe(true);
    expect(() => strategyFloorWindow(m, "AIRBNB", 2, "2026-01-01", "2027-06-01")).toThrow(/400 nuits/);
  });
});

describe("auditeur : plancher stratégique de la saison du séjour", () => {
  const ctx = (model: EconomicModel, from: string, to: string) => ({ model, strategy: { basePriceCents: 12000, minPriceCents: 6000, maxPriceCents: 20000, minStay: 2, maxDiscountStackPct: 30, maxPriceChangePct: 20 } as never, stalePromoChannels: [], conflict: false, capabilities: {}, demo: false, promos: [], window: { from, to } });
  const draft = (soldNightlyCents: number) => {
    const state = { channel: "AIRBNB" as const, nights: 2, publishedNightlyCents: soldNightlyCents, soldNightlyCents, cumulativeDiscountPct: 0, grossRoomCents: soldNightlyCents * 2, netRoomCents: 0, contributionCents: 0, contributionPerNightCents: 0, netAdrCents: 0, steps: [] };
    return { type: "PRICE_OVERRIDE", label: "x", current: null, proposed: state, parameters: {}, target: { system: "PRICELABS" }, priceChangePct: -5 } as never;
  };
  it("hors saison PASS, en saison WARN, à prix vendu identique", () => {
    const m = base({ seasons: [SUMMER] });
    const out = (from: string, to: string) => auditCandidate(draft(7000), ctx(m, from, to)).rules.find((r) => r.code === "STRATEGY_FLOOR")!;
    expect(out("2026-03-10", "2026-03-12").outcome).toBe("PASS");
    const inSeason = out("2026-07-10", "2026-07-12");
    expect(inSeason.outcome).toBe("WARN");
    expect(inSeason.detail).toContain("saison « Été »");
  });
});
