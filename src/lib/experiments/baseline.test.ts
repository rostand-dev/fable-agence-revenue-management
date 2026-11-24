import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { computeBaseline, netPerNight, pickupOf, type BookedNight } from "./baseline";

const N = (night: string, bookedAt: string, gross = 10000, commission: number | null = 1500, channel = "AIRBNB"): BookedNight => ({ night, bookedAt, channel, grossRoomCents: gross, commissionCents: commission, paymentFeeCents: null });
const EFF = "2026-11-24";
const base = { asOf: EFF, effectiveOn: EFF, stayFrom: "2026-12-01", stayTo: "2026-12-08", blocked: [] as string[], firstBookingDate: "2025-01-10", firstStayDate: "2025-01-12" };

describe("pickupOf : nuits des séjours visés réservées pendant une fenêtre", () => {
  const stay = { from: "2026-12-01", to: "2026-12-08" }, book = { from: "2026-11-10", to: "2026-11-24" };
  it("ne compte que les nuits du séjour réservées dans la fenêtre (bornes : from inclus, to exclu)", () => {
    const nights = [N("2026-12-01", "2026-11-10"), N("2026-12-02", "2026-11-23"), N("2026-12-03", "2026-11-24"), N("2026-12-04", "2026-11-09"), N("2026-12-08", "2026-11-15"), N("2026-11-30", "2026-11-15")];
    const p = pickupOf(nights, stay, book);
    expect(p.nights).toBe(2);
    expect(p.days).toBe(14);
    expect(p.perDay).toBeCloseTo(2 / 14, 10);
    expect(p.grossCents).toBe(20000);
  });
  it("net : somme des nuits à commission connue seulement ; une commission inconnue n'est pas un zéro", () => {
    const p = pickupOf([N("2026-12-01", "2026-11-12", 10000, 1500), N("2026-12-02", "2026-11-12", 10000, null)], stay, book);
    expect(p.nights).toBe(2);
    expect(p.netNights).toBe(1);
    expect(p.netCents).toBe(8500);
    expect(netPerNight(p)).toBe(8500);
  });
  it("frais de paiement retranchés quand ils existent ; aucun net si aucune commission connue", () => {
    const withFee: BookedNight = { ...N("2026-12-01", "2026-11-12", 10000, 1500), paymentFeeCents: 200 };
    expect(pickupOf([withFee], stay, book).netCents).toBe(8300);
    const none = pickupOf([N("2026-12-01", "2026-11-12", 10000, null)], stay, book);
    expect(none.netCents).toBeNull();
    expect(netPerNight(none)).toBeNull();
  });
  it("aucune nuit : rythme nul mais net inconnu (et non zéro)", () => {
    const p = pickupOf([], stay, book);
    expect(p).toMatchObject({ nights: 0, perDay: 0, netCents: null, netNights: 0 });
  });
});

describe("baseline (US-110)", () => {
  it("fige l'état des séjours visés, le rythme de référence et le comparable de l'an passé", () => {
    const nights = [
      N("2026-12-01", "2026-11-12"), N("2026-12-02", "2026-11-18"), N("2026-12-03", "2026-10-01"), // la 3e est réservée avant la fenêtre de référence
      N("2025-12-02", "2025-11-13"), N("2025-12-03", "2025-11-14"), N("2025-12-04", "2025-11-20"), // an passé : décalage de 364 jours
    ];
    const b = computeBaseline({ ...base, nights, blocked: ["2026-12-05"] });
    expect(b.sufficient).toBe(true);
    expect(b.limits).toEqual([]);
    expect(b.window).toEqual({ from: "2026-11-10", to: "2026-11-24", days: 14 });
    expect(b.stay).toEqual({ from: "2026-12-01", to: "2026-12-08", nights: 7 });
    expect(b.onBooks).toEqual({ bookedNights: 3, blockedNights: 1, availableNights: 6, occupancy: 0.5 });
    expect(b.pickup).toMatchObject({ nights: 2, days: 14, grossCents: 20000 });
    expect(b.comparable.available).toBe(true);
    expect(b.comparable.window).toEqual({ from: "2025-11-11", to: "2025-11-25" });
    expect(b.comparable.pickupNights).toBe(3);
  });
  it("une nuit à la fois réservée et bloquée compte comme réservée", () => {
    const b = computeBaseline({ ...base, nights: [N("2026-12-01", "2026-11-12")], blocked: ["2026-12-01", "2026-12-02"] });
    expect(b.onBooks).toMatchObject({ bookedNights: 1, blockedNights: 1, availableNights: 6 });
  });
  it("les séjours déjà commencés sont ramenés aux nuits à venir", () => {
    const b = computeBaseline({ ...base, stayFrom: "2026-11-20", stayTo: "2026-12-08", nights: [N("2026-11-21", "2026-11-01"), N("2026-12-02", "2026-11-15")] });
    expect(b.stay).toEqual({ from: "2026-11-24", to: "2026-12-08", nights: 14 });
    expect(b.pickup?.nights).toBe(1); // la nuit du 21/11 est passée : ni référence ni mesure
    expect(b.onBooks?.bookedNights).toBe(1);
  });
  it("toutes les nuits passées : baseline insuffisante, sans chiffre inventé", () => {
    const b = computeBaseline({ ...base, stayFrom: "2026-11-10", stayTo: "2026-11-20", nights: [N("2026-11-12", "2026-11-01")] });
    expect(b.sufficient).toBe(false);
    expect(b.limits).toContain("STAY_PAST");
    expect(b.stay).toBeNull();
    expect(b.pickup).toBeNull();
    expect(b.onBooks).toBeNull();
    expect(b.comparable).toMatchObject({ available: false, reason: "STAY_PAST" });
  });
  it("sans réservation connue : insuffisante (NO_HISTORY), le zéro n'est pas une référence", () => {
    const b = computeBaseline({ ...base, nights: [], firstBookingDate: null, firstStayDate: null });
    expect(b.sufficient).toBe(false);
    expect(b.limits).toEqual(["NO_HISTORY"]);
    expect(b.comparable).toMatchObject({ available: false, reason: "NO_HISTORY", pickupNights: null });
    expect(b.pickup?.nights).toBe(0);
  });
  it("historique plus récent que la fenêtre de référence : insuffisante (HISTORY_TOO_SHORT)", () => {
    const b = computeBaseline({ ...base, nights: [N("2026-12-01", "2026-11-20")], firstBookingDate: "2026-11-15", firstStayDate: "2026-11-30" });
    expect(b.sufficient).toBe(false);
    expect(b.limits).toEqual(["HISTORY_TOO_SHORT"]);
  });
  it("historique de plus de 14 jours mais de moins d'un an : référence suffisante, comparable indisponible", () => {
    const b = computeBaseline({ ...base, nights: [N("2026-12-01", "2026-11-20")], firstBookingDate: "2026-06-01", firstStayDate: "2026-06-10" });
    expect(b.sufficient).toBe(true);
    expect(b.comparable).toMatchObject({ available: false, reason: "HISTORY_TOO_SHORT", pickupNights: null });
  });
  it("le comparable exige aussi que les nuits de l'an passé aient été lues (première nuit connue)", () => {
    const b = computeBaseline({ ...base, nights: [], firstBookingDate: "2025-01-10", firstStayDate: "2026-01-01" });
    expect(b.comparable).toMatchObject({ available: false, reason: "HISTORY_TOO_SHORT" });
  });
  it("la baseline ne dépend que de ses entrées : même entrée, même résultat (immuable, rejouable)", () => {
    const nights = [N("2026-12-01", "2026-11-12"), N("2026-12-02", "2026-11-18")];
    expect(computeBaseline({ ...base, nights })).toEqual(computeBaseline({ ...base, nights: [...nights].reverse() }));
  });
  it("propriété : le rythme de référence ne dépasse jamais le nombre de nuits visées", () => {
    for (let len = 1; len <= 20; len++) {
      const stayTo = addDays("2026-12-01", len);
      const nights = Array.from({ length: len }, (_, k) => N(addDays("2026-12-01", k), "2026-11-15"));
      const b = computeBaseline({ ...base, stayTo, nights });
      expect(b.pickup!.nights).toBeLessThanOrEqual(b.stay!.nights);
      expect(b.pickup!.nights).toBe(len);
    }
  });
});

describe("date d'entrée en vigueur dans le passé (procédure déclarée après coup)", () => {
  it("l'état des séjours exclut les réservations postérieures à l'entrée en vigueur : la baseline ne mêle pas deux instants", () => {
    const eff = "2026-11-18";
    const nights = [N("2026-12-01", "2026-11-10"), N("2026-12-02", "2026-11-17"), N("2026-12-03", "2026-11-18"), N("2026-12-04", "2026-11-22")];
    const b = computeBaseline({ ...base, asOf: "2026-11-24", effectiveOn: eff, nights });
    expect(b.onBooks?.bookedNights).toBe(2);
    expect(b.pickup?.nights).toBe(2);
    expect(b.capturedLate).toBe(true);
  });
  it("capture le jour même : pas de capture tardive", () => {
    expect(computeBaseline({ ...base, nights: [] }).capturedLate).toBe(false);
  });
});
