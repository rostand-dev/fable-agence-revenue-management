import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { channelMarkupsOf } from "../services/review";
import { markupFactor, reviewProperty, type EngineInput } from "./detect";
import { hardFloorCents } from "./economics";
import type { Day, EconomicModel } from "./types";

/**
 * Cas réel relevé sur le staging le 21 nov. 2026 (Chez Fiatope) :
 * SuperHote affiche 78 € pour la nuit du 20 nov. (PriceLabs `user_price` : 81 €), la majoration Airbnb est de 23 %.
 * Le moteur ouvrait un veto « prix vendu 81 € sous le plancher de 82 € » alors que le prix Airbnb réel est ≈ 96 €.
 */
const model: EconomicModel = {
  channels: { AIRBNB: { commissionPct: 18.8, paymentFeePct: 0 } },
  cleaningFeeChargedCents: 0, cleaningCostCents: 200, linenCostCents: 0, nightlyVariableCostCents: 600,
  hardContributionPerNightCents: 6000, strategyContributionPerNightCents: 9200, targetContributionPerNightCents: 9200, origin: "DECLARED",
};
const today = "2026-11-20";
const day = (offset: number, priceCents: number | null): Day => ({
  date: addDays(today, offset), state: "FREE", priceCents, minStay: 2, rule: null, marketOccupancy: null, marketAdrCents: null, pricePercentile: null, event: null,
});
function input(over: Partial<EngineInput> & { price?: number; minPrice?: number | null } = {}): EngineInput {
  const { price = 7800, minPrice = 7600, ...rest } = over;
  return {
    today, now: new Date(today + "T09:00:00Z"), property: { id: "p", name: "Chez Fiatope", isDemo: false }, model,
    strategy: { basePriceCents: 9600, minPriceCents: minPrice, maxPriceCents: null, minStay: 2, maxDiscountStackPct: 20, maxPriceChangePct: 5 },
    days: [day(0, price), day(1, price), day(2, price)], promos: [], resas: [], capabilities: capabilityFlags({ isDemo: false, killSwitch: {} }), activeRanges: [],
    markups: { AIRBNB: 23 }, priceSource: "SUPERHOTE", ...rest,
  };
}
const by = (i: EngineInput, pb: string) => reviewProperty(i).opportunities.filter((o) => o.playbook === pb);

describe("majoration de canal dans le prix vendu", () => {
  it("le plancher absolu du cas réel est d'environ 83 € par nuit sur 2 nuits", () => {
    expect(hardFloorCents(model, "AIRBNB", 2)).toBe(8252);
  });
  it("78 € au calendrier + 23 % = ~96 € sur Airbnb : aucun veto de plancher", () => {
    expect(by(input({ price: 7800 }), "PB-06")).toHaveLength(0);
  });
  it("sans majoration (ancien comportement), le même prix déclenchait un faux veto", () => {
    const o = by(input({ price: 7800, markups: undefined }), "PB-06");
    expect(o).toHaveLength(1);
    expect(o[0].veto).toBe(true);
  });
  it("une vraie violation reste détectée : 60 € + 23 % = 73,80 € sous le plancher", () => {
    const [o] = by(input({ price: 6000 }), "PB-06");
    expect(o).toBeDefined();
    const hard = o.candidates.find((c) => c.parameters.floorKind === "absolu")!;
    // prix du calendrier le plus bas dont le prix Airbnb (× 1,23, après commission) atteint le plancher : 68 € × 1,23 = 83,64 € ≥ 82,52 €
    expect(hard.parameters.nightlyCents).toBe(6800);
    expect(hard.proposed!.soldNightlyCents).toBeGreaterThanOrEqual(hardFloorCents(model, "AIRBNB", 2));
    expect(o.diagnosis.evidence.some((e) => e.label === "Majoration Airbnb" && e.value === "+23 %")).toBe(true);
    expect(o.diagnosis.evidence.some((e) => e.label === "Calcul du prix proposé")).toBe(true);
  });
  it("le texte du diagnostic ne parle pas de remises quand il n'y en a aucune", () => {
    const [o] = by(input({ price: 6000 }), "PB-06");
    expect(o.hypothesisText).not.toMatch(/une fois les remises/);
    expect(o.hypothesisText).toMatch(/aucune remise/);
  });
  it("une majoration inconnue n'est jamais traitée comme 0 % : le canal est exclu de la revue", () => {
    const r = reviewProperty(input({ price: 6000, markups: { AIRBNB: null } }));
    expect(r.missingMarkups).toEqual(["AIRBNB"]);
    expect(r.opportunities).toHaveLength(0);
    expect(() => markupFactor({ AIRBNB: null }, "AIRBNB")).toThrow(/majoration Airbnb/);
  });
  it("la source du prix est indiquée sur la preuve", () => {
    const [o] = by(input({ price: 6000 }), "PB-06");
    expect(o.diagnosis.evidence.find((e) => e.label === "Prix du calendrier (avant majoration)")!.source).toBe("SuperHote · calendrier");
  });
});

describe("PB-11 : prix minimum PriceLabs sous le plancher", () => {
  it("76 € × 1,23 = 93,48 € : pas d'alerte, le minimum n'a pas à être relevé", () => {
    expect(by(input({ minPrice: 7600 }), "PB-11")).toHaveLength(0);
  });
  it("sans majoration (0 %), 76 € est sous le plancher de ~82,52 € : l'agent d'onboarding propose 83 €", () => {
    const [o] = by(input({ minPrice: 7600, markups: { AIRBNB: 0 } }), "PB-11");
    expect(o).toBeDefined();
    expect(o.veto).toBe(false);
    const c = o.candidates[o.selected];
    expect(c.type).toBe("MIN_PRICE_CHANGE");
    expect(c.agent).toBe("onboarding");
    expect(c.parameters).toMatchObject({ previousMinPriceCents: 7600, minPriceCents: 8300 });
    expect(c.proposed!.soldNightlyCents).toBeGreaterThanOrEqual(hardFloorCents(model, "AIRBNB", 2));
    // l'inaction est présentée au même niveau, et rejetée par l'auditeur
    expect(o.candidates.find((x) => x.type === "NO_ACTION")!.audit.verdict).toBe("REJECT");
  });
  it("l'écriture par API n'est proposée que si la capacité d'écriture existe ; sinon procédure manuelle", () => {
    const [manual] = by(input({ minPrice: 7600, markups: { AIRBNB: 0 }, capabilities: {} }), "PB-11");
    expect(manual.candidates[manual.selected].executionMode).toBe("MANUAL_RUNBOOK");
    const [api] = by(input({ minPrice: 7600, markups: { AIRBNB: 0 }, capabilities: { "pricelabs.write": true } }), "PB-11");
    expect(api.candidates[api.selected].executionMode).toBe("API_PRICELABS");
  });
  it("une action en observation sur le calendrier ne rend pas l'option inapplicable (le minimum vaut pour toutes les dates)", () => {
    const [o] = by(input({ minPrice: 7600, markups: { AIRBNB: 0 }, activeRanges: [{ from: today, to: addDays(today, 90) }] }), "PB-11");
    const c = o.candidates[o.selected];
    expect(c.type).toBe("MIN_PRICE_CHANGE");
    expect(c.audit.rules.some((r) => r.code === "CONFLICT" && r.outcome === "FAIL")).toBe(false);
    expect(c.audit.verdict).not.toBe("REJECT");
  });
  it("avec Airbnb et Booking, le minimum proposé satisfait le canal le plus exigeant", () => {
    const two: EconomicModel = { ...model, channels: { AIRBNB: { commissionPct: 18.8, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1.4 } } };
    const [o] = by(input({ model: two, minPrice: 7600, markups: { AIRBNB: 0, BOOKING: 0 } }), "PB-11");
    const need = Math.max(...(["AIRBNB", "BOOKING"] as const).map((c) => Math.ceil(hardFloorCents(two, c, 2) / 100) * 100));
    expect(o.candidates[o.selected].parameters.minPriceCents).toBe(need);
  });
  it("pas d'alerte si le minimum est inconnu", () => {
    expect(by(input({ minPrice: null, markups: { AIRBNB: 0 } }), "PB-11")).toHaveLength(0);
  });
});

describe("channelMarkupsOf", () => {
  it("relie les clés saisies aux canaux du moteur ; non renseigné = null, jamais 0", () => {
    expect(channelMarkupsOf([{ key: "airbnb", pct: 23 }, { key: "booking", pct: null }])).toEqual({ AIRBNB: 23, BOOKING: null });
    expect(channelMarkupsOf([{ key: "booking-com", pct: 18 }])).toEqual({ AIRBNB: null, BOOKING: 18 });
    expect(channelMarkupsOf([])).toEqual({ AIRBNB: null, BOOKING: null });
    expect(channelMarkupsOf(undefined)).toEqual({ AIRBNB: null, BOOKING: null });
    // valeur illisible ou hors plage venue de la base : inconnue, jamais appliquée
    expect(channelMarkupsOf([{ key: "airbnb", pct: -100 }, { key: "booking", pct: 250 }])).toEqual({ AIRBNB: null, BOOKING: null });
  });
});
