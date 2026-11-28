import { describe, expect, it } from "vitest";
import { computeKpi, monthPeriod, type NightFact } from "./kpi";
import { compareMonths, direction, monthName, monthValues, trendLabel, trendMonths } from "./trend";

const nights = (month: string, n: number, grossRoomCents = 10000, commissionCents: number | null = 0): NightFact[] =>
  Array.from({ length: n }, (_, i) => ({ night: `${month}-${String(i + 1).padStart(2, "0")}`, channel: "AIRBNB", grossRoomCents, commissionCents, paymentFeeCents: null }));
const oct = (sold: NightFact[], blocked: string[] = []) => computeKpi(monthPeriod("2026-10"), sold, blocked);
const nov = (sold: NightFact[], blocked: string[] = []) => computeKpi(monthPeriod("2026-11"), sold, blocked);

describe("direction", () => {
  it("stable jusqu'à 5 % inclus, dans les deux sens", () => {
    expect(direction(105, 100)).toBe("STABLE");
    expect(direction(95, 100)).toBe("STABLE");
    expect(direction(106, 100)).toBe("UP");
    expect(direction(94, 100)).toBe("DOWN");
    expect(direction(1.05, 1)).toBe("STABLE");
  });
  it("depuis zéro : stable si toujours zéro, sinon le sens du montant", () => {
    expect(direction(0, 0)).toBe("STABLE");
    expect(direction(1, 0)).toBe("UP");
    expect(direction(-1, 0)).toBe("DOWN");
  });
  it("base négative : le sens suit la valeur", () => {
    expect(direction(-50, -100)).toBe("UP");
    expect(direction(-150, -100)).toBe("DOWN");
  });
});

describe("trendMonths", () => {
  it("mois en cours et précédent, passage d'année compris", () => {
    expect(trendMonths("2026-11-27")).toEqual({ month: "2026-11", previousMonth: "2026-10" });
    expect(trendMonths("2027-01-01")).toEqual({ month: "2027-01", previousMonth: "2026-12" });
  });
});

describe("compareMonths", () => {
  it("compare le revenu net, l'occupation et le prix moyen net", () => {
    const t = compareMonths(nov(nights("2026-11", 20, 8000, 0)), oct(nights("2026-10", 15, 10000, 0)), "FULL", "FRESH");
    expect(t.month).toBe("2026-11");
    expect(t.previousMonth).toBe("2026-10");
    expect(t.revenue).toEqual({ direction: "UP", reason: null }); // 160 000 contre 150 000
    expect(t.occupancy.direction).toBe("UP");
    expect(t.price.direction).toBe("DOWN");
  });
  it("le prix moyen est net des commissions", () => {
    const t = compareMonths(nov(nights("2026-11", 10, 10000, 2000)), oct(nights("2026-10", 10, 10000, 0)), "FULL", "FRESH");
    expect(t.price.direction).toBe("DOWN");
  });
  it.each([
    ["NO_HISTORY", "aucune réservation lue"],
    ["PARTIAL", "historique incomplet en octobre 2026"],
    ["BEFORE_HISTORY", "aucun historique en octobre 2026"],
  ] as const)("historique %s : les trois tendances sont inconnues, avec leur motif", (coverage, reason) => {
    const t = compareMonths(nov(nights("2026-11", 5)), oct([]), coverage, "FRESH");
    for (const k of ["revenue", "occupancy", "price"] as const) expect(t[k]).toEqual({ direction: "UNKNOWN", reason });
  });
  it("commission inconnue : revenu et prix inconnus, jamais un zéro ; l'occupation reste lue", () => {
    for (const unknownNights of [nights("2026-11", 10, 10000, null), [...nights("2026-11", 10), { ...nights("2026-11", 1, 10000, null)[0], night: "2026-11-20" }]]) {
      const t = compareMonths(nov(unknownNights), oct(nights("2026-10", 10)), "FULL", "FRESH");
      expect(t.revenue).toEqual({ direction: "UNKNOWN", reason: "commissions manquantes" });
      expect(t.price).toEqual({ direction: "UNKNOWN", reason: "commissions manquantes" });
      expect(t.occupancy.direction).not.toBe("UNKNOWN");
    }
  });
  it("mois lu sans aucune nuit vendue : revenu et occupation en baisse (vrai zéro), prix inconnu", () => {
    const t = compareMonths(nov([]), oct(nights("2026-10", 10)), "FULL", "FRESH");
    expect(t.revenue.direction).toBe("DOWN");
    expect(t.occupancy.direction).toBe("DOWN");
    expect(t.price).toEqual({ direction: "UNKNOWN", reason: "aucune nuit vendue en novembre 2026" });
  });
  it("source pas à jour : les trois tendances sont inconnues, même avec deux mois sans aucune nuit", () => {
    for (const [cur, prev] of [[[], []], [[], nights("2026-10", 10)], [nights("2026-11", 5), nights("2026-10", 10)]]) {
      const t = compareMonths(nov(cur), oct(prev), "FULL", "STALE");
      for (const k of ["revenue", "occupancy", "price"] as const) expect(t[k]).toEqual({ direction: "UNKNOWN", reason: "réservations pas à jour" });
    }
  });
  it("sans source reliée : un mois en cours vide est inconnu, un mois en cours saisi se compare", () => {
    const empty = compareMonths(nov([]), oct(nights("2026-10", 10)), "FULL", "UNLINKED");
    for (const k of ["revenue", "occupancy", "price"] as const) expect(empty[k]).toEqual({ direction: "UNKNOWN", reason: "aucune réservation enregistrée en novembre 2026" });
    expect(compareMonths(nov(nights("2026-11", 20)), oct(nights("2026-10", 10)), "FULL", "UNLINKED").occupancy.direction).toBe("UP");
  });
  it("mois entièrement bloqué : occupation inconnue", () => {
    const blocked = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    expect(compareMonths(nov([], blocked), oct(nights("2026-10", 10)), "FULL", "FRESH").occupancy).toEqual({ direction: "UNKNOWN", reason: "aucune nuit disponible" });
  });
});

describe("trendLabel", () => {
  it("accorde « inconnu » avec l'indicateur", () => {
    expect(trendLabel("occupancy", "UNKNOWN")).toBe("inconnue");
    expect(trendLabel("revenue", "UNKNOWN")).toBe("inconnu");
    expect(trendLabel("price", "DOWN")).toBe("en baisse");
  });
});

describe("monthValues", () => {
  it("donne le revenu net, l'occupation et le prix moyen net du mois", () => {
    expect(monthValues(nov(nights("2026-11", 15, 10000, 2000)), "FULL", "FRESH")).toEqual({
      revenue: { value: 120000, reason: null }, occupancy: { value: 0.5, reason: null }, price: { value: 8000, reason: null },
    });
  });
  it.each([
    ["NO_HISTORY", "FRESH", "aucune réservation lue"],
    ["PARTIAL", "FRESH", "historique incomplet en novembre 2026"],
    ["BEFORE_HISTORY", "FRESH", "aucun historique en novembre 2026"],
    ["FULL", "STALE", "réservations pas à jour"],
  ] as const)("%s / %s : aucune valeur, avec le motif", (coverage, source, reason) => {
    const v = monthValues(nov(nights("2026-11", 5)), coverage, source);
    for (const k of ["revenue", "occupancy", "price"] as const) expect(v[k]).toEqual({ value: null, reason });
  });
  it("mois lu sans nuit vendue : revenu et occupation à zéro (vrai zéro), prix inconnu", () => {
    expect(monthValues(nov([]), "FULL", "FRESH")).toEqual({
      revenue: { value: 0, reason: null }, occupancy: { value: 0, reason: null }, price: { value: null, reason: "aucune nuit vendue en novembre 2026" },
    });
  });
  it("sans source reliée, un mois vide est inconnu", () => {
    expect(monthValues(nov([]), "FULL", "UNLINKED").revenue).toEqual({ value: null, reason: "aucune réservation enregistrée en novembre 2026" });
    expect(monthValues(nov(nights("2026-11", 3)), "FULL", "UNLINKED").revenue.value).toBe(30000);
  });
  it("commission inconnue : revenu et prix inconnus, occupation lue ; mois entièrement bloqué : occupation inconnue", () => {
    const v = monthValues(nov(nights("2026-11", 3, 10000, null)), "FULL", "FRESH");
    expect(v.revenue).toEqual({ value: null, reason: "commissions manquantes" });
    expect(v.price).toEqual({ value: null, reason: "commissions manquantes" });
    expect(v.occupancy.value).toBeCloseTo(0.1);
    const blocked = Array.from({ length: 30 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    expect(monthValues(nov([], blocked), "FULL", "FRESH").occupancy).toEqual({ value: null, reason: "aucune nuit disponible" });
  });
  it("nomme un mois sans son année", () => {
    expect(monthName("2026-11")).toBe("novembre");
  });
});
