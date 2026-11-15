import { describe, expect, it } from "vitest";
import { estimateAllChannels, estimatePublishedPrice, isEstimable, markupKey, parseMarkupList, parseMarkupPct, pickDefaultChannel, sentMinusRecommended, type ChannelMarkup } from "./published";
import { comparePublishedPrice, DEFAULT_TOLERANCE_CENTS } from "../integrations/superhote-check";

const free = (recommendedPriceCents: number | null) => ({ state: "FREE" as const, recommendedPriceCents });

describe("prix publié estimé", () => {
  it("applique price × (1 + majoration / 100)", () => {
    expect(estimatePublishedPrice(free(10000), 15)?.exactCents).toBe(11500);
    expect(estimatePublishedPrice(free(10000), 15)?.displayEuros).toBe(115);
    expect(estimatePublishedPrice(free(13000), 18)?.displayEuros).toBe(153); // 153,40 €
  });
  it("garde la valeur exacte et n'arrondit qu'à l'affichage", () => {
    const e = estimatePublishedPrice(free(9999), 15.5)!;           // 115,48845 €
    expect(e.exactCents).toBeCloseTo(11548.845, 6);
    expect(e.displayEuros).toBe(115);
  });
  it("arrondit à l'euro, la demi-unité allant vers le haut", () => {
    expect(estimatePublishedPrice(free(13000), 15)?.displayEuros).toBe(150); // 149,50 → 150
    expect(estimatePublishedPrice(free(12999), 15)?.displayEuros).toBe(149); // 149,4885 → 149
  });
  it("ne souffre pas du bruit des flottants (100 × 1,15)", () => {
    expect(estimatePublishedPrice(free(10000), 15)?.exactCents).toBe(11500);
  });
  it("majoration à 0 % : valide, le prix reste celui envoyé", () => {
    expect(estimatePublishedPrice(free(10000), 0)?.displayEuros).toBe(100);
  });
  it("majoration non renseignée → inconnue, jamais traitée comme 0 %", () => {
    expect(estimatePublishedPrice(free(10000), null)).toBeNull();
    expect(estimatePublishedPrice(free(10000), undefined)).toBeNull();
  });
  it("majoration invalide (négative, NaN) → pas d'estimation", () => {
    expect(estimatePublishedPrice(free(10000), -5)).toBeNull();
    expect(estimatePublishedPrice(free(10000), Number.NaN)).toBeNull();
  });
  it("dates réservées ou bloquées → pas d'estimation, même avec un prix", () => {
    expect(estimatePublishedPrice({ state: "BOOKED", recommendedPriceCents: 10000 }, 15)).toBeNull();
    expect(estimatePublishedPrice({ state: "BLOCKED", recommendedPriceCents: 10000 }, 15)).toBeNull();
  });
  it("price absent, nul ou négatif → pas d'estimation", () => {
    for (const p of [null, undefined, 0, -100]) expect(isEstimable({ state: "FREE", recommendedPriceCents: p })).toBe(false);
    expect(estimatePublishedPrice(free(null), 15)).toBeNull();
  });
  it("user_price n'entre pas dans le calcul : seul le prix recommandé compte", () => {
    const day = { state: "FREE" as const, recommendedPriceCents: 10000, sentPriceCents: 13000 };
    expect(estimatePublishedPrice(day, 15)?.displayEuros).toBe(115);                              // 100 € × 1,15, et non 130 € × 1,15
    expect(estimatePublishedPrice({ state: "FREE", recommendedPriceCents: null, sentPriceCents: 13000 } as never, 15)).toBeNull(); // pas de repli sur user_price
  });
  it("estime chaque canal, et laisse inconnus ceux sans majoration", () => {
    const m: ChannelMarkup[] = [{ key: "airbnb", label: "Airbnb", pct: 15 }, { key: "booking", label: "Booking", pct: null }];
    const r = estimateAllChannels(free(10000), m);
    expect(r[0].estimate?.displayEuros).toBe(115);
    expect(r[1].estimate).toBeNull();
  });
  it("canal par défaut : demandé > Airbnb > premier renseigné ; aucun si rien n'est renseigné", () => {
    const m: ChannelMarkup[] = [{ key: "booking", label: "Booking", pct: 18 }, { key: "airbnb", label: "Airbnb", pct: 15 }, { key: "direct", label: "Direct", pct: null }];
    expect(pickDefaultChannel(m)?.key).toBe("airbnb");
    expect(pickDefaultChannel(m, "booking")?.key).toBe("booking");
    expect(pickDefaultChannel(m, "direct")?.key).toBe("airbnb");          // canal demandé non renseigné
    expect(pickDefaultChannel([{ key: "booking", label: "Booking", pct: 18 }])?.key).toBe("booking");
    expect(pickDefaultChannel([{ key: "airbnb", label: "Airbnb", pct: null }])).toBeNull();
    expect(pickDefaultChannel([])).toBeNull();
  });
  it("écart envoyé − recommandé", () => {
    expect(sentMinusRecommended(12000, 11000)).toBe(1000);
    expect(sentMinusRecommended(10500, 11000)).toBe(-500);
    expect(sentMinusRecommended(null, 11000)).toBeNull();
    expect(sentMinusRecommended(12000, null)).toBeNull();
  });
});

describe("saisie d'une majoration", () => {
  it("accepte entiers, décimales (virgule ou point) et signe %", () => {
    expect(parseMarkupPct("15")).toEqual({ ok: true, pct: 15 });
    expect(parseMarkupPct("15,5")).toEqual({ ok: true, pct: 15.5 });
    expect(parseMarkupPct("15.25")).toEqual({ ok: true, pct: 15.25 });
    expect(parseMarkupPct(" 18 % ")).toEqual({ ok: true, pct: 18 });
    expect(parseMarkupPct("0")).toEqual({ ok: true, pct: 0 });
  });
  it("vide → inconnue (null), pas 0", () => {
    expect(parseMarkupPct("")).toEqual({ ok: true, pct: null });
    expect(parseMarkupPct("   ")).toEqual({ ok: true, pct: null });
    expect(parseMarkupPct(null)).toEqual({ ok: true, pct: null });
  });
  it("refuse négatif, texte, plus de deux décimales et plus de 100 %", () => {
    for (const bad of ["-3", "abc", "15,123", "1e2", "15 €"]) expect(parseMarkupPct(bad).ok).toBe(false);
    expect(parseMarkupPct("100").ok).toBe(true);
    expect(parseMarkupPct("100,01").ok).toBe(false);
    expect(parseMarkupPct("250").ok).toBe(false);
  });
  it("identifiant de canal sans accents ni casse", () => {
    expect(markupKey("  Airbnb ")).toBe("airbnb");
    expect(markupKey("Réservation directe")).toBe("reservation-directe");
  });
});

describe("préparation de la vérification SuperHote", () => {
  it("tolérance par défaut : 1 €", () => expect(DEFAULT_TOLERANCE_CENTS).toBe(100));
  it("écart dans la tolérance (≤ 1 €) → OK, borne incluse", () => {
    expect(comparePublishedPrice(11500, 11500).status).toBe("OK");
    expect(comparePublishedPrice(11500, 11600).status).toBe("OK");
    expect(comparePublishedPrice(11500, 11400).status).toBe("OK");
  });
  it("au-delà → majoration à vérifier, avec l'écart signé", () => {
    expect(comparePublishedPrice(11500, 11601)).toEqual({ status: "A_VERIFIER", gapCents: 101 });
    expect(comparePublishedPrice(11500, 10000)).toEqual({ status: "A_VERIFIER", gapCents: -1500 });
  });
  it("tolérance personnalisable", () => expect(comparePublishedPrice(11500, 11700, 300).status).toBe("OK"));
  it("prix inconnu d'un côté ou de l'autre → inconnu", () => {
    expect(comparePublishedPrice(null, 11500).status).toBe("INCONNU");
    expect(comparePublishedPrice(11500, null).status).toBe("INCONNU");
  });
});

describe("liste de majorations du formulaire", () => {
  it("lit les lignes, ignore les lignes vides et garde un nom sans pourcentage comme inconnu", () => {
    expect(parseMarkupList(["Airbnb", "", "Booking"], ["15", "", ""])).toEqual({ ok: true, markups: [{ key: "airbnb", label: "Airbnb", pct: 15 }, { key: "booking", label: "Booking", pct: null }] });
  });
  it("refuse un pourcentage sans nom, un doublon et une valeur invalide", () => {
    expect(parseMarkupList([""], ["15"]).ok).toBe(false);
    expect(parseMarkupList(["Airbnb", " airbnb "], ["15", "16"]).ok).toBe(false);
    expect(parseMarkupList(["Airbnb"], ["-1"]).ok).toBe(false);
    expect(parseMarkupList(["Airbnb"], ["15,555"]).ok).toBe(false);
  });
  it("liste vide acceptée", () => expect(parseMarkupList([], [])).toEqual({ ok: true, markups: [] }));
});
