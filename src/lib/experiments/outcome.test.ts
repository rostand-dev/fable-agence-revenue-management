import { describe, expect, it } from "vitest";
import { computeBaseline, type BookedNight } from "./baseline";
import { classifyOutcome, DILUTION_THRESHOLD, MIN_OBSERVATION_DAYS, OUTCOME_LABEL, OUTCOMES, type OutcomeInput } from "./outcome";

const N = (night: string, bookedAt: string, gross = 10000, commission: number | null = 1500): BookedNight => ({ night, bookedAt, channel: "AIRBNB", grossRoomCents: gross, commissionCents: commission, paymentFeeCents: null });
const EFF = "2026-11-10";
const STAY = { stayFrom: "2026-12-01", stayTo: "2026-12-20" };
const addD = (d: string, n: number) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
/** `k` nuits de décembre réservées à partir de `from` (un jour de réservation par nuit). */
const booked = (k: number, from: string, gross = 10000, commission: number | null = 1500): BookedNight[] => Array.from({ length: k }, (_, j) => N(addD("2026-12-01", j), addD(from, j % 7), gross, commission));
const baselineWith = (before: BookedNight[], over: Partial<Parameters<typeof computeBaseline>[0]> = {}) => computeBaseline({ asOf: EFF, effectiveOn: EFF, ...STAY, nights: before, blocked: [], firstBookingDate: "2025-01-01", firstStayDate: "2025-01-05", ...over });
const input = (over: Partial<OutcomeInput> & { before?: BookedNight[]; after?: BookedNight[] } = {}): OutcomeInput => {
  const before = over.before ?? booked(14, "2026-10-27"), after = over.after ?? [];
  return { baseline: baselineWith(before), observation: { from: EFF, to: addD(EFF, 14) }, nights: [...before, ...after], reservationsFresh: true, overlapping: 0, ...over };
};
const afterN = (k: number, gross = 10000, commission: number | null = 1500) => Array.from({ length: k }, (_, j) => N(addD("2026-12-01", 14 + (j % 5)), addD(EFF, j % 14), gross, commission));

describe("classifyOutcome : seuils", () => {
  it("rythme inchangé : neutre", () => {
    const r = classifyOutcome(input({ after: afterN(14) }));
    expect(r.outcome).toBe("NEUTRAL");
    expect(r.deltaNights).toBeCloseTo(0, 5);
  });
  it("accélération nette : positif, sans prétendre à une cause", () => {
    const r = classifyOutcome(input({ after: afterN(19) }));
    expect(r.outcome).toBe("POSITIVE");
    expect(r.interpretation).toMatch(/ne prouve pas qu'elle en soit la cause/);
    expect(r.confidence).toBe("faible");
  });
  it("ralentissement net : négatif (le résultat négatif existe désormais)", () => {
    expect(classifyOutcome(input({ after: afterN(8) })).outcome).toBe("NEGATIVE");
  });
  it("les deux seuils sont exigés : +2 nuits mais moins de 25 % reste neutre", () => {
    const r = classifyOutcome(input({ before: booked(14, "2026-10-27"), after: afterN(16) }));
    expect(r.deltaNights).toBeCloseTo(2, 5);
    expect(r.relativeChange!).toBeLessThan(0.25);
    expect(r.outcome).toBe("NEUTRAL");
  });
  it("bornes exactes : +25 % et +2 nuits est positif ; juste en dessous, neutre", () => {
    // référence 8 nuits en 14 jours → attendu 8 sur 14 jours ; 10 observées = +2 nuits, +25 %
    const before = booked(8, "2026-10-27");
    expect(classifyOutcome(input({ before, after: afterN(10) })).outcome).toBe("POSITIVE");
    expect(classifyOutcome(input({ before, after: afterN(9) })).outcome).toBe("NEUTRAL");
    expect(classifyOutcome(input({ before, after: afterN(6) })).outcome).toBe("NEGATIVE");
    expect(classifyOutcome(input({ before, after: afterN(7) })).outcome).toBe("NEUTRAL");
  });
  it("référence à zéro nuit : deux nuits observées suffisent, une seule non", () => {
    expect(classifyOutcome(input({ before: [], after: afterN(2) })).outcome).toBe("POSITIVE");
    expect(classifyOutcome(input({ before: [], after: afterN(1) })).outcome).toBe("NEUTRAL");
    expect(classifyOutcome(input({ before: [], after: [] })).outcome).toBe("NEUTRAL");
  });
  it("les durées diffèrent : on compare des rythmes par jour, pas des totaux", () => {
    // 14 nuits en 14 jours avant ; 7 jours d'observation : attendu 7 nuits
    const r = classifyOutcome(input({ observation: { from: EFF, to: addD(EFF, 7) }, after: afterN(7) }));
    expect(r.expectedNights).toBeCloseTo(7, 5);
    expect(r.outcome).toBe("NEUTRAL");
  });
});

describe("classifyOutcome : non concluant, jamais deviné", () => {
  it("expérience héritée (aucune baseline)", () => {
    const r = classifyOutcome(input({ baseline: null, after: afterN(30) }));
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons).toContain("LEGACY");
    expect(r.observed).toBeNull();
  });
  it("baseline insuffisante : aucune réservation connue avant", () => {
    const r = classifyOutcome(input({ baseline: baselineWith([], { firstBookingDate: null, firstStayDate: null }), after: afterN(30) }));
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons).toContain("BASELINE_INSUFFICIENT");
  });
  it("historique trop court pour la fenêtre de référence", () => {
    const r = classifyOutcome(input({ baseline: baselineWith(booked(5, "2026-11-01"), { firstBookingDate: "2026-11-01" }), after: afterN(30) }));
    expect(r.outcome).toBe("INCONCLUSIVE");
  });
  it("séjours déjà passés à l'entrée en vigueur", () => {
    const r = classifyOutcome(input({ baseline: baselineWith([], { stayFrom: "2026-11-01", stayTo: "2026-11-05" }) }));
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons).toContain("STAY_PAST");
  });
  it("observation absente ou trop courte", () => {
    expect(classifyOutcome(input({ observation: null })).reasons).toContain("NO_OBSERVATION_WINDOW");
    const short = classifyOutcome(input({ observation: { from: EFF, to: addD(EFF, MIN_OBSERVATION_DAYS - 1) }, after: afterN(30) }));
    expect(short.outcome).toBe("INCONCLUSIVE");
    expect(short.reasons).toContain("OBSERVATION_TOO_SHORT");
    expect(classifyOutcome(input({ observation: { from: EFF, to: addD(EFF, MIN_OBSERVATION_DAYS) }, after: afterN(30) })).reasons).not.toContain("OBSERVATION_TOO_SHORT");
    expect(classifyOutcome(input({ observation: { from: EFF, to: EFF } })).reasons).toContain("NO_OBSERVATION_WINDOW");
  });
  it("réservations non synchronisées : une absence de réservation ne prouve rien", () => {
    const r = classifyOutcome(input({ reservationsFresh: false, after: [] }));
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons).toContain("RESERVATIONS_STALE");
    expect(r.interpretation).toMatch(/titre indicatif/);
  });
  it("autre action mêlée sur les mêmes séjours : effets non séparables, même si le rythme a bondi", () => {
    const r = classifyOutcome(input({ overlapping: 1, after: afterN(30) }));
    expect(r.outcome).toBe("INCONCLUSIVE");
    expect(r.reasons).toContain("OVERLAPPING_ACTION");
  });
  it("plusieurs raisons sont toutes dites", () => {
    const r = classifyOutcome(input({ baseline: null, observation: null, reservationsFresh: false, overlapping: 2 }));
    expect(r.reasons).toEqual(expect.arrayContaining(["LEGACY", "NO_OBSERVATION_WINDOW", "RESERVATIONS_STALE", "OVERLAPPING_ACTION"]));
  });
});

describe("classifyOutcome : dilution par le prix", () => {
  it("gain de volume mais net par nuit en baisse de plus de 15 % : neutre, motif dit", () => {
    const r = classifyOutcome(input({ after: afterN(19, 10000, 3500) }));
    expect(r.outcome).toBe("NEUTRAL");
    expect(r.reasons).toContain("PRICE_DILUTION");
    expect(r.observedNetPerNight!).toBeLessThan(r.baseNetPerNight! * (1 - DILUTION_THRESHOLD));
  });
  it("net en baisse de moins de 15 % : le gain reste positif", () => {
    expect(classifyOutcome(input({ after: afterN(19, 10000, 2000) })).outcome).toBe("POSITIVE");
  });
  it("net inconnu d'un côté : la dilution ne se devine pas", () => {
    const r = classifyOutcome(input({ after: afterN(19, 10000, null) }));
    expect(r.outcome).toBe("POSITIVE");
    expect(r.observedNetPerNight).toBeNull();
    expect(r.reasons).not.toContain("PRICE_DILUTION");
  });
});

describe("libellés", () => {
  it("les quatre résultats ont un libellé français", () => {
    expect(OUTCOMES.map((o) => OUTCOME_LABEL[o])).toEqual(["Positif", "Neutre", "Négatif", "Non concluant"]);
  });
});
