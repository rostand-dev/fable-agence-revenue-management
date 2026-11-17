import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { calendarPatches } from "../integrations/superhote-reservations";
import { awaitingGrid, backoffMinutes, CADENCE_HOURS, computeCadence, everyLabel, levelFor, marketOccupancy30, reservationChanges, rollMarketRef } from "./cadence";
import type { Day, Resa } from "./types";

const today = "2026-11-17";
const day = (offset: number, o: Partial<Day> = {}): Day => ({ date: addDays(today, offset), state: "BOOKED", priceCents: 12000, minStay: 2, rule: null, marketOccupancy: 0.6, marketAdrCents: 11000, pricePercentile: 50, event: null, ...o });
const calendar = (free: number[], extra: Record<number, Partial<Day>> = {}): Day[] => Array.from({ length: 91 }, (_, i) => day(i, { state: free.includes(i) ? "FREE" : "BOOKED", ...extra[i] }));
const resa = (bookedOffset: number, lead: number): Resa => ({ channel: "AIRBNB", checkIn: addDays(today, bookedOffset + lead), checkOut: addDays(today, bookedOffset + lead + 3), nights: 3, grossRoomCents: 30000, commissionCents: 4500, paymentFeeCents: 0, bookedAt: addDays(today, bookedOffset), status: "CONFIRMED" });
/** Historique de dix réservations anciennes au délai donné : fixe le délai médian sans peser sur le pickup. */
const history = (lead: number): Resa[] => Array.from({ length: 10 }, (_, i) => resa(-60 - i * 7, lead));
const base = { today, followUps: 0, marketDeltaPts: null, hasSuperhote: true };

describe("rythme de suivi adaptatif", () => {
  it("logement calme : calendrier plein, aucune réservation récente, réservations anticipées", () => {
    const c = computeCadence({ ...base, days: calendar([40, 41]), resas: history(45) });
    expect(c.level).toBe("CALME");
    expect([c.reservationsEveryH, c.pricesEveryH, c.reviewEveryH]).toEqual([6, 24, 48]);
    expect(c.reasons).toContain("aucune nuit libre dans les 14 prochains jours");
  });
  it("logement soutenu : nuits libres proches, réservations récentes, dernière minute, marché agité", () => {
    const c = computeCadence({ ...base, marketDeltaPts: 6, days: calendar([1, 2, 3, 5, 6, 9]), resas: [...history(5), resa(-1, 4), resa(-2, 6), resa(-5, 3)] });
    expect(c.level).toBe("SOUTENU");
    expect([c.reservationsEveryH, c.pricesEveryH, c.reviewEveryH]).toEqual([1, 12, 6]);
    expect(c.reasons[0]).toMatch(/nuits libres dans les 14 prochains jours|réservations reçues en 7 jours/);
    expect(c.reasons.join(" ")).toContain("occupation du marché en hausse de 6 points");
  });
  it("palier intermédiaire et raisons triées de la plus lourde à la plus légère", () => {
    const c = computeCadence({ ...base, days: calendar([2, 3, 4]), resas: [...history(15), resa(-3, 10)] });
    expect(c.score).toBe(5); // 3 nuits libres (2) + 1 réservation en 7 j (2) + délai médian 15 j (1)
    expect(c.level).toBe("ACTIF");
    expect(c.reviewEveryH).toBe(12);
  });
  it("une action en observation impose au moins une revue par jour", () => {
    const quiet = computeCadence({ ...base, days: calendar([]), resas: history(45) });
    const followed = computeCadence({ ...base, followUps: 1, days: calendar([]), resas: history(45) });
    expect(quiet.reviewEveryH).toBe(48);
    expect(followed.reviewEveryH).toBeLessThanOrEqual(24);
  });
  it("une baisse du marché compte autant qu'une hausse et se lit en clair", () => {
    const c = computeCadence({ ...base, marketDeltaPts: -7, days: calendar([20]), resas: history(45) });
    expect(c.reasons).toContain("occupation du marché en baisse de 7 points");
  });
  it("sans SuperHote, la lecture des réservations ne descend pas sous 3 h", () => {
    const c = computeCadence({ ...base, hasSuperhote: false, marketDeltaPts: 6, days: calendar([1, 2, 3, 5, 6, 9]), resas: [...history(5), resa(-1, 4), resa(-2, 6), resa(-5, 3)] });
    expect(c.reservationsEveryH).toBe(3);
  });
  it("démonstration et calendrier absent : rythme quotidien fixe", () => {
    expect(computeCadence({ ...base, isDemo: true, days: calendar([1, 2, 3, 4, 5]), resas: [] }).reviewEveryH).toBe(24);
    expect(computeCadence({ ...base, days: [], resas: [] }).reasons[0]).toContain("Calendrier pas encore lu");
  });
  it("les paliers couvrent les bornes validées : 1 h à 6 h, 12 h à 24 h, 6 h à 48 h", () => {
    const all = Object.values(CADENCE_HOURS);
    expect([Math.min(...all.map((h) => h.reservations)), Math.max(...all.map((h) => h.reservations))]).toEqual([1, 6]);
    expect([Math.min(...all.map((h) => h.prices)), Math.max(...all.map((h) => h.prices))]).toEqual([12, 24]);
    expect([Math.min(...all.map((h) => h.review)), Math.max(...all.map((h) => h.review))]).toEqual([6, 48]);
    expect([levelFor(0), levelFor(2), levelFor(5), levelFor(8)]).toEqual(["CALME", "REGULIER", "ACTIF", "SOUTENU"]);
  });
});

describe("relevé de marché de référence", () => {
  const t0 = new Date("2026-11-17T08:00:00Z");
  it("premier relevé : pas de variation connue", () => {
    expect(rollMarketRef(null, 0.5, t0)).toEqual({ value: 0.5, at: t0.toISOString(), deltaPts: null });
  });
  it("moins de 24 h : le relevé de référence ne bouge pas", () => {
    const ref = rollMarketRef(null, 0.5, t0)!;
    expect(rollMarketRef(ref, 0.6, new Date(+t0 + 5 * 3600000))).toBe(ref);
  });
  it("après 24 h : la variation est mesurée en points", () => {
    const ref = rollMarketRef(null, 0.5, t0)!;
    expect(rollMarketRef(ref, 0.56, new Date(+t0 + 25 * 3600000))!.deltaPts).toBe(6);
  });
  it("marché non lu : le relevé précédent est conservé", () => {
    expect(marketOccupancy30([], today)).toBeNull();
    expect(rollMarketRef(null, null, t0)).toBeNull();
  });
});

describe("garde-fous du planificateur", () => {
  it("les tentatives s'espacent après des échecs, sans dépasser 6 h", () => {
    expect([1, 2, 3, 4, 5, 6, 12].map(backoffMinutes)).toEqual([15, 30, 60, 120, 240, 360, 360]);
  });
  it("grille PriceLabs pas encore recalculée cette nuit : relecture rapprochée", () => {
    expect(awaitingGrid("2026-11-16T03:00:00Z", "2026-11-17T02:00:00Z")).toBe(true);
    expect(awaitingGrid("2026-11-17T01:00:00Z", "2026-11-17T02:00:00Z")).toBe(false);
    expect(awaitingGrid("2026-11-10T01:00:00Z", "2026-11-17T02:00:00Z")).toBe(false); // synchro arrêtée : pas de relecture en boucle
    expect(awaitingGrid(null, "2026-11-17T02:00:00Z")).toBe(false);
  });
  it("repère une réservation nouvelle ou annulée entre deux lectures", () => {
    expect(reservationChanges(new Set(["a", "b"]), new Set(["b", "c", "d"]))).toEqual({ added: 2, cancelled: 1 });
    expect(reservationChanges(new Set(["a"]), new Set(["a"]))).toEqual({ added: 0, cancelled: 0 });
  });
  it("libellés d'intervalle", () => {
    expect([1, 2, 12, 24, 48].map(everyLabel)).toEqual(["toutes les heures", "toutes les 2 h", "toutes les 12 h", "une fois par jour", "tous les 2 jours"]);
  });
});

describe("calendrier ajusté par la lecture légère SuperHote", () => {
  const d = (offset: number, state: string, o: any = {}) => ({ date: addDays(today, offset), state, priceCents: state === "FREE" ? 12000 : null, sentPriceCents: state === "FREE" ? 12000 : null, recommendedPriceCents: 11500, ...o });
  const days = [d(0, "FREE"), d(1, "FREE"), d(2, "BOOKED"), d(3, "BOOKED"), d(4, "FREE"), d(5, "BLOCKED")];
  const avail = days.map((x) => ({ date: x.date, available: true }));
  it("une nouvelle réservation ferme ses nuits, sans toucher aux autres", () => {
    const p = calendarPatches(days, [{ checkIn: addDays(today, 0), checkOut: addDays(today, 2), status: "CONFIRMED" }, { checkIn: addDays(today, 2), checkOut: addDays(today, 4), status: "CONFIRMED" }], avail, today);
    expect(p.map((x) => [x.date, x.state])).toEqual([[addDays(today, 0), "BOOKED"], [addDays(today, 1), "BOOKED"]]);
  });
  it("une annulation ne libère la nuit que si SuperHote la déclare disponible, au dernier prix connu", () => {
    const freed = calendarPatches(days, [], avail, today);
    expect(freed.map((x) => [x.date, x.state, x.priceCents])).toEqual([[addDays(today, 2), "FREE", 11500], [addDays(today, 3), "FREE", 11500]]);
    expect(calendarPatches(days, [], avail.map((a) => ({ ...a, available: false })), today)).toEqual([]);
  });
  it("un blocage propriétaire retire la nuit du disponible", () => {
    const p = calendarPatches(days, [{ checkIn: addDays(today, 4), checkOut: addDays(today, 5), status: "BLOCKED" }, { checkIn: addDays(today, 2), checkOut: addDays(today, 4), status: "CONFIRMED" }], avail, today);
    expect(p).toEqual([{ date: addDays(today, 4), state: "BLOCKED", priceCents: null, sentPriceCents: null }]);
  });
});
