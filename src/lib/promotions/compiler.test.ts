import { describe, expect, it } from "vitest";
import { emptyEconomics } from "../engine/economics";
import type { Channel, EconomicModel } from "../engine/types";
import { strategyFloorWindow } from "../engine/seasons";
import { advanceText, compilePromotions, parseCompileInput, windowText, type ActiveRow, type CompileContext, type CompileInput } from "./compiler";

const TODAY = "2026-11-24";
const model = (over: Partial<EconomicModel> = {}): EconomicModel => ({ ...emptyEconomics(), cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } }, ...over });
const input = (over: Partial<CompileInput> = {}): CompileInput => ({ intent: "STIMULATE_NEAR_TERM_DEMAND", stayFrom: "2026-12-10", stayTo: "2026-12-20", maxDiscountPct: 10, channels: ["BOOKING", "AIRBNB"], publishedNightlyCents: { BOOKING: 10000, AIRBNB: 10000 }, minLos: null, advanceDays: 7, ...over });
const ctx = (over: Partial<CompileContext> = {}): CompileContext => ({ model: model(), maxDiscountStackPct: 30, active: [], registryStale: {}, ...over });
const act = (over: Partial<ActiveRow> = {}): ActiveRow => ({ channel: "BOOKING", kind: "GENIUS", label: "Genius 10 %", discountPct: 10, stayFrom: null, stayTo: null, ...over });
const of = (r: ReturnType<typeof compilePromotions>, c: Channel) => r.outcomes.find((o) => o.channel === c)!;

describe("compilateur de promotions · saisie (US-101)", () => {
  const ok = { intent: "STIMULATE_NEAR_TERM_DEMAND", stayFrom: "2026-12-10", stayTo: "2026-12-20", maxDiscountPct: "10", channel_BOOKING: "on", price_BOOKING: "119,50" };
  it("saisie valide : prix en euros → centimes entiers, délai par défaut de la demande proche", () => {
    const r = parseCompileInput(ok, TODAY);
    expect(r.ok && r.value).toMatchObject({ channels: ["BOOKING"], publishedNightlyCents: { BOOKING: 11950 }, advanceDays: 7, minLos: null, maxDiscountPct: 10 });
  });
  it.each([
    ["intention inconnue", { intent: "X" }, "intention"],
    ["fin avant début", { stayTo: "2026-12-10" }, "après leur début"],
    ["séjours passés", { stayFrom: "2026-11-01", stayTo: "2026-11-10" }, "déjà passés"],
    ["date impossible", { stayFrom: "2026-02-30" }, "dates de séjour"],
    ["fenêtre de plus d'un an", { stayTo: "2028-01-01" }, "366 nuits"],
    ["remise nulle", { maxDiscountPct: "0" }, "entre 1 et 80"],
    ["remise de 95 %", { maxDiscountPct: "95" }, "entre 1 et 80"],
    ["remise à deux décimales (dépasserait par arrondi)", { maxDiscountPct: "10,25" }, "entre 1 et 80"],
    ["remise texte", { maxDiscountPct: "dix" }, "entre 1 et 80"],
    ["aucun canal", { channel_BOOKING: "" }, "au moins un canal"],
    ["prix manquant", { price_BOOKING: "" }, "prix publié"],
    ["prix négatif", { price_BOOKING: "-5" }, "prix publié"],
    ["séjour minimal absurde", { minLos: "400" }, "entre 1 et 365"],
    ["délai demande proche trop long", { advanceDays: "90" }, "60 jours au plus"],
  ])("refuse : %s", (_n, over, msg) => {
    const r = parseCompileInput({ ...ok, ...over }, TODAY);
    expect(!r.ok && r.error).toContain(msg);
  });
  it("délai ignoré pour les intentions qui ne l'utilisent pas ; début de fenêtre passé ramené à aujourd'hui", () => {
    const r = parseCompileInput({ ...ok, intent: "TARGET_MARKET", advanceDays: "10", stayFrom: "2026-11-01" }, TODAY);
    expect(r.ok && r.value).toMatchObject({ advanceDays: null, stayFrom: TODAY });
  });
  it("long séjour : 7 nuits par défaut, entre 2 et 90 ; très anticipé : 60 jours par défaut, 30 au moins", () => {
    const ls = parseCompileInput({ ...ok, intent: "STIMULATE_LONG_STAY" }, TODAY);
    expect(ls.ok && ls.value.minLos).toBe(7);
    expect(parseCompileInput({ ...ok, intent: "STIMULATE_LONG_STAY", minLos: "1" }, TODAY).ok).toBe(false);
    const eb = parseCompileInput({ ...ok, intent: "STIMULATE_EARLY_BOOKING" }, TODAY);
    expect(eb.ok && eb.value.advanceDays).toBe(60);
    expect(parseCompileInput({ ...ok, intent: "STIMULATE_EARLY_BOOKING", advanceDays: "10" }, TODAY).ok).toBe(false);
  });
});

describe("compilateur de promotions · traduction par canal (blueprint §10.2)", () => {
  it("demande proche : Mobile sur Booking.com (audience mobile), dernière minute sur Airbnb ; remise maximale tenue quand les planchers le permettent", () => {
    const r = compilePromotions(input(), ctx());
    const b = of(r, "BOOKING"), a = of(r, "AIRBNB");
    expect(b).toMatchObject({ status: "COMPILED", settings: { kind: "MOBILE", discountPct: 10, audience: "MOBILE", advanceMode: "AT_MOST", advanceDays: 7 } });
    expect(a).toMatchObject({ status: "COMPILED", settings: { kind: "LAST_MINUTE", discountPct: 10, audience: "ALL" } });
    expect(r.pricelabsNote).toContain("double baisse");
  });
  it("longs séjours : Airbnb en remise de durée, Booking.com sans équivalent (aucun type dans le registre de cumul)", () => {
    const r = compilePromotions(input({ intent: "STIMULATE_LONG_STAY", minLos: 7, advanceDays: null }), ctx());
    expect(of(r, "AIRBNB")).toMatchObject({ status: "COMPILED", settings: { kind: "LOS", minLos: 7, advanceMode: null } });
    expect(of(r, "BOOKING")).toMatchObject({ status: "NO_SAFE_EQUIVALENT", code: "NO_CHANNEL_TYPE" });
  });
  it("très anticipé : early-bird sur Airbnb seulement ; marché cible : tarif par pays sur Booking.com seulement", () => {
    const e = compilePromotions(input({ intent: "STIMULATE_EARLY_BOOKING", advanceDays: 60 }), ctx());
    expect(of(e, "AIRBNB")).toMatchObject({ status: "COMPILED", settings: { kind: "EARLY_BIRD", advanceMode: "AT_LEAST", advanceDays: 60 } });
    expect(of(e, "BOOKING")).toMatchObject({ code: "NO_CHANNEL_TYPE" });
    const t = compilePromotions(input({ intent: "TARGET_MARKET", advanceDays: null }), ctx());
    expect(of(t, "BOOKING")).toMatchObject({ status: "COMPILED", settings: { kind: "COUNTRY", audience: "COUNTRY" } });
    expect(of(t, "AIRBNB")).toMatchObject({ code: "NO_CHANNEL_TYPE" });
  });
  it("un canal refusé n'empêche pas l'autre : un seul canal demandé = un seul résultat", () => {
    expect(compilePromotions(input({ channels: ["AIRBNB"] }), ctx()).outcomes.map((o) => o.channel)).toEqual(["AIRBNB"]);
  });
});

describe("compilateur de promotions · planchers (jamais sous le plancher)", () => {
  it("la remise est ramenée au plus grand pas de 0,5 point qui garde le prix vendu au-dessus du plancher stratégique", () => {
    // Airbnb, séjour minimal de 2 nuits : plancher stratégique 57,36 € ; prix publié 70 € → 18 % donne 57,40 €, 18,5 % donne 57,05 €
    const o = of(compilePromotions(input({ maxDiscountPct: 30, minLos: 2, channels: ["AIRBNB"], publishedNightlyCents: { AIRBNB: 7000 } }), ctx({ maxDiscountStackPct: 40 })), "AIRBNB");
    expect(o.status).toBe("COMPILED");
    if (o.status === "NO_SAFE_EQUIVALENT") throw new Error("inattendu");
    expect(o.settings.discountPct).toBe(18);
    expect(o.notes.join(" ")).toContain("ramenée de 30 % à 18 %");
    expect(o.simulation.result.soldNightlyCents).toBeGreaterThanOrEqual(o.simulation.floors.strategyCents);
  });
  it("prix publié déjà sous le plancher : NO_SAFE_EQUIVALENT, aucune remise proposée", () => {
    const o = of(compilePromotions(input({ channels: ["AIRBNB"], publishedNightlyCents: { AIRBNB: 5000 } }), ctx()), "AIRBNB");
    expect(o).toMatchObject({ status: "NO_SAFE_EQUIVALENT", code: "FLOOR" });
  });
  it("propriété : quel que soit le prix et la remise maximale, une promotion compilée ne passe jamais sous le plancher absolu ni le plancher stratégique", () => {
    for (let price = 3000; price <= 20000; price += 700) for (const max of [5, 10, 25, 50, 80]) {
      for (const intent of ["STIMULATE_NEAR_TERM_DEMAND", "STIMULATE_LONG_STAY", "STIMULATE_EARLY_BOOKING", "TARGET_MARKET"] as const) {
        const r = compilePromotions(input({ intent, minLos: intent === "STIMULATE_LONG_STAY" ? 7 : null, maxDiscountPct: max, publishedNightlyCents: { AIRBNB: price, BOOKING: price } }), ctx({ maxDiscountStackPct: 80 }));
        for (const o of r.outcomes) if (o.status !== "NO_SAFE_EQUIVALENT") {
          expect(o.simulation.result.soldNightlyCents).toBeGreaterThanOrEqual(o.simulation.floors.hardCents);
          expect(o.simulation.result.soldNightlyCents).toBeGreaterThanOrEqual(o.simulation.floors.strategyCents);
          expect(o.settings.discountPct).toBeLessThanOrEqual(max);
          expect(o.simulation.reconciles).toBe(true);
        }
      }
    }
  });
  it("remise maximale à demi-point : jamais dépassée (1,2 → 1)", () => {
    const o = of(compilePromotions(input({ maxDiscountPct: 1.2, channels: ["AIRBNB"] }), ctx()), "AIRBNB");
    expect(o.status === "NO_SAFE_EQUIVALENT" ? -1 : o.settings.discountPct).toBe(1);
  });
  it("sans séjour minimal, les planchers se vérifient sur 1 nuit (le ménage y pèse le plus)", () => {
    const o = of(compilePromotions(input({ channels: ["AIRBNB"] }), ctx()), "AIRBNB");
    if (o.status === "NO_SAFE_EQUIVALENT") throw new Error("inattendu");
    expect(o.simulation.result.nights).toBe(1);
  });
  it("saisons : une haute saison au milieu de la fenêtre impose son plancher plus exigeant à toute la proposition", () => {
    const seasonal = model({ seasons: [{ id: "ete", label: "Haute saison", from: "12-15", to: "12-18", strategyContributionPerNightCents: 9000 }] });
    const plain = of(compilePromotions(input({ maxDiscountPct: 30, minLos: 2, channels: ["AIRBNB"], publishedNightlyCents: { AIRBNB: 12000 } }), ctx({ maxDiscountStackPct: 40 })), "AIRBNB");
    const high = of(compilePromotions(input({ maxDiscountPct: 30, minLos: 2, channels: ["AIRBNB"], publishedNightlyCents: { AIRBNB: 12000 } }), ctx({ model: seasonal, maxDiscountStackPct: 40 })), "AIRBNB");
    if (plain.status === "NO_SAFE_EQUIVALENT") throw new Error("inattendu");
    if (high.status !== "NO_SAFE_EQUIVALENT") {
      expect(high.settings.discountPct).toBeLessThan(plain.settings.discountPct);
      expect(high.simulation.result.soldNightlyCents).toBeGreaterThanOrEqual(strategyFloorWindow(seasonal, "AIRBNB", 2, "2026-12-10", "2026-12-20").floor);
    }
  });
  it("plafond de cumul trop bas : refus STACK_CAP, pas FLOOR", () => {
    const o = of(compilePromotions(input({ channels: ["AIRBNB"] }), ctx({ maxDiscountStackPct: 0.5 })), "AIRBNB");
    expect(o).toMatchObject({ status: "NO_SAFE_EQUIVALENT", code: "STACK_CAP" });
  });
  it("déterministe : même entrée, même sortie", () => {
    expect(compilePromotions(input(), ctx())).toEqual(compilePromotions(input(), ctx()));
  });
});

describe("compilateur de promotions · registre et cumul (blueprint §10.4)", () => {
  it("même type déjà actif sur ces séjours : refusé, deux remises visant le même signal ne se superposent pas", () => {
    const o = of(compilePromotions(input(), ctx({ active: [act({ kind: "MOBILE", label: "Mobile 8 %" })] })), "BOOKING");
    expect(o).toMatchObject({ status: "NO_SAFE_EQUIVALENT", code: "ALREADY_ACTIVE" });
  });
  it("Airbnb : une seule remise principale s'applique, une nouvelle ne change rien de sûr ; la remise voyageur très bien noté se cumule", () => {
    const ex = of(compilePromotions(input(), ctx({ active: [act({ channel: "AIRBNB", kind: "CUSTOM", label: "Perso" })] })), "AIRBNB");
    expect(ex).toMatchObject({ code: "EXCLUSIVE_WITH_ACTIVE" });
    const ok = of(compilePromotions(input(), ctx({ active: [act({ channel: "AIRBNB", kind: "TOP_RATED", label: "Très bien noté", discountPct: 5 })] })), "AIRBNB");
    expect(ok.status).toBe("COMPILED");
  });
  it("règle de cumul inconnue (Genius × Mobile) : proposition conservée mais NEEDS_HUMAN, jamais devinée", () => {
    const o = of(compilePromotions(input(), ctx({ active: [act()] })), "BOOKING");
    expect(o.status).toBe("NEEDS_HUMAN");
    if (o.status === "NEEDS_HUMAN") expect(o.humanReasons.join(" ")).toContain("Règle de cumul inconnue");
  });
  it("registre vide : le silence d'un registre tenu à la main ne prouve rien, décision humaine", () => {
    const o = of(compilePromotions(input(), ctx({ registryEmpty: { BOOKING: true } })), "BOOKING");
    expect(o.status).toBe("NEEDS_HUMAN");
    if (o.status === "NEEDS_HUMAN") expect(o.humanReasons.join(" ")).toContain("Aucune promotion n'est inscrite");
  });
  it("promotion active hors de la fenêtre de séjours : ignorée", () => {
    const o = of(compilePromotions(input(), ctx({ active: [act({ stayFrom: "2027-02-01", stayTo: "2027-02-10" })] })), "BOOKING");
    expect(o.status).toBe("COMPILED");
  });
  it("registre non relu depuis plus de 7 jours : NEEDS_HUMAN", () => {
    const o = of(compilePromotions(input(), ctx({ registryStale: { BOOKING: true } })), "BOOKING");
    expect(o.status).toBe("NEEDS_HUMAN");
  });
});

describe("compilateur de promotions · données manquantes", () => {
  it("modèle économique incomplet : MISSING_DATA, rien d'inventé", () => {
    expect(of(compilePromotions(input(), ctx({ model: model({ cleaningCostCents: null }) })), "AIRBNB")).toMatchObject({ status: "NO_SAFE_EQUIVALENT", code: "MISSING_DATA" });
  });
  it("plafond de cumul inconnu : MISSING_DATA", () => {
    expect(of(compilePromotions(input(), ctx({ maxDiscountStackPct: null })), "AIRBNB")).toMatchObject({ code: "MISSING_DATA" });
  });
  it("fenêtre plus courte que le séjour minimal : WINDOW_TOO_SHORT", () => {
    const o = of(compilePromotions(input({ intent: "STIMULATE_LONG_STAY", minLos: 14, stayTo: "2026-12-15", advanceDays: null }), ctx()), "AIRBNB");
    expect(o).toMatchObject({ code: "WINDOW_TOO_SHORT" });
  });
});

describe("textes", () => {
  it("fenêtre et délai en français", () => {
    expect(windowText({ stayFrom: "2026-12-10", stayTo: "2026-12-20" })).toBe("Séjours du 10/12/2026 au 19/12/2026 inclus");
    expect(advanceText({ advanceDays: 7, advanceMode: "AT_MOST" })).toBe("Réservable au plus 7 jours avant l'arrivée");
    expect(advanceText({ advanceDays: 60, advanceMode: "AT_LEAST" })).toBe("Réservable au moins 60 jours avant l'arrivée");
    expect(advanceText({ advanceDays: null, advanceMode: null })).toBeNull();
  });
});
