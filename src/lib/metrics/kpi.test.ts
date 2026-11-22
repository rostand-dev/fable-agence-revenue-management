import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { allocate } from "../reservations/nights";
import { computeKpi, kpiByMonth, monthPeriod, nightFactsFromResas, periodDays, type NightFact } from "./kpi";

const night = (n: string, gross: number, commission: number | null = 0, channel = "AIRBNB", fee: number | null = null): NightFact => ({ night: n, channel, grossRoomCents: gross, commissionCents: commission, paymentFeeCents: fee });
const P = { from: "2026-10-01", to: "2026-10-11" }; // 10 nuits

describe("KPI canoniques (US-050)", () => {
  it("occupation, ADR, Net ADR, RevPAN et Net RevPAN sur un cas calculé à la main", () => {
    // 4 nuits vendues sur 10 : 3 × 10 000 (commission 1 500, frais 140) et 1 × 12 000 (commission 1 800)
    const sold = [night("2026-10-01", 10000, 1500, "BOOKING", 140), night("2026-10-02", 10000, 1500, "BOOKING", 140), night("2026-10-03", 10000, 1500, "BOOKING", 140), night("2026-10-05", 12000, 1800)];
    const k = computeKpi(P, sold);
    expect(k).toMatchObject({ days: 10, availableNights: 10, soldNights: 4, blockedNights: 0, grossRoomCents: 42000, adrCents: 10500, grossRevpanCents: 4200, netStatus: "COMPLETE", netNights: 4, netCoverage: 1 });
    expect(k.occupancy).toBe(0.4);
    expect(k.netRoomCents).toBe(42000 - 4500 - 1800 - 420); // 35 280
    expect(k.netAdrCents).toBe(8820);
    expect(k.netRevpanCents).toBe(3528);
    expect(k.byChannel.map((c) => [c.channel, c.soldNights, c.netRoomCents])).toEqual([["BOOKING", 3, 3 * (10000 - 1500 - 140)], ["AIRBNB", 1, 10200]]);
  });

  it("les nuits bloquées par le propriétaire ne sont pas disponibles ; une nuit vendue et bloquée reste vendue", () => {
    const k = computeKpi(P, [night("2026-10-01", 10000), night("2026-10-02", 10000)], ["2026-10-02", "2026-10-06", "2026-10-07", "2026-09-30", "2026-10-11"]);
    expect(k.blockedNights).toBe(2); // 06 et 07 seulement : 02 est vendue, 30/09 et 11/10 sont hors période
    expect(k.availableNights).toBe(8);
    expect(k.occupancy).toBe(2 / 8);
  });

  it("une commission inconnue n'est jamais un zéro : la nuit sort du net, le statut le dit, le Net RevPAN devient inconnu", () => {
    const k = computeKpi(P, [night("2026-10-01", 10000, 1500), night("2026-10-02", 10000, null)]);
    expect(k.netStatus).toBe("PARTIAL");
    expect(k.soldNights).toBe(2); expect(k.grossRoomCents).toBe(20000); expect(k.adrCents).toBe(10000); // le brut garde les deux nuits
    expect(k.netNights).toBe(1); expect(k.netCoverage).toBe(0.5);
    expect(k.netRoomCents).toBe(8500); expect(k.netAdrCents).toBe(8500); // Net ADR sans biais : calculé sur les nuits connues
    expect(k.netRevpanCents).toBeNull(); // ni 850 (sous-évalué) ni 1 700 (si l'inconnu valait zéro) : inconnu
  });

  it("aucune commission connue : net inconnu ; aucune nuit vendue : net réellement nul", () => {
    const u = computeKpi(P, [night("2026-10-01", 10000, null)]);
    expect(u.netStatus).toBe("UNKNOWN"); expect(u.netRoomCents).toBeNull(); expect(u.netAdrCents).toBeNull(); expect(u.netRevpanCents).toBeNull(); expect(u.adrCents).toBe(10000);
    const none = computeKpi(P, []);
    expect(none).toMatchObject({ netStatus: "NONE", soldNights: 0, occupancy: 0, adrCents: null, netAdrCents: null, netRoomCents: 0, netRevpanCents: 0, netCoverage: null });
  });

  it("une période sans nuit disponible n'a ni occupation ni RevPAN (division par zéro évitée)", () => {
    const allBlocked = Array.from({ length: 10 }, (_, i) => addDays("2026-10-01", i));
    const k = computeKpi(P, [], allBlocked);
    expect(k.availableNights).toBe(0); expect(k.occupancy).toBeNull(); expect(k.grossRevpanCents).toBeNull(); expect(k.netRevpanCents).toBeNull();
  });

  it("une double réservation est signalée, pas corrigée en silence", () => {
    const k = computeKpi(P, [night("2026-10-01", 10000), night("2026-10-01", 9000, 0, "BOOKING")]);
    expect(k.soldNights).toBe(2); expect(k.overlappingNights).toBe(1); expect(k.occupancy).toBe(0.1); expect(k.grossRoomCents).toBe(19000);
  });

  it("les nuits hors période sont ignorées ; frais de paiement absents = aucun frais ; net négatif conservé", () => {
    const k = computeKpi(P, [night("2026-09-30", 99999), night("2026-10-11", 99999), night("2026-10-03", 1000, 1200)]);
    expect(k.soldNights).toBe(1); expect(k.netRoomCents).toBe(-200); expect(k.netAdrCents).toBe(-200);
  });

  it("combine blocage, double réservation et commission inconnue sans mélanger les compteurs", () => {
    const k = computeKpi(P, [night("2026-10-01", 10000, 0), night("2026-10-01", 9000, null, "BOOKING"), night("2026-10-02", 5000, null)], ["2026-10-01", "2026-10-03"]);
    expect(k).toMatchObject({ soldNights: 3, overlappingNights: 1, blockedNights: 1, availableNights: 9, netStatus: "PARTIAL", netNights: 1, netRoomCents: 10000 });
    expect(k.occupancy).toBe(2 / 9);
  });

  it("refuse une période invalide ou démesurée", () => {
    expect(() => periodDays({ from: "2026-10-05", to: "2026-10-05" })).toThrow(RangeError);
    expect(() => periodDays({ from: "2026-10-05", to: "2026-10-01" })).toThrow(RangeError);
    expect(() => periodDays({ from: "2020-01-01", to: "2026-01-01" })).toThrow(RangeError);
    expect(periodDays({ from: "2026-02-01", to: "2026-03-01" })).toBe(28);
  });

  it("les mois civils se découpent aux bonnes dates (février, année bissextile, changement d'année)", () => {
    expect(monthPeriod("2028-02")).toEqual({ from: "2028-02-01", to: "2028-03-01" });
    expect(monthPeriod("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    const ks = kpiByMonth(["2026-12", "2027-01"], [night("2026-12-31", 1000), night("2027-01-01", 2000)]);
    expect(ks.map((k) => [k.soldNights, k.grossRoomCents])).toEqual([[1, 1000], [1, 2000]]);
  });

  it("réservations → nuits : même répartition en centimes que la base, annulées et doublons sans nuit, blocages à part", () => {
    const base = { channel: "BOOKING", commissionCents: 1001, paymentFeeCents: 100 };
    const { sold, blocked } = nightFactsFromResas([
      { ...base, status: "CONFIRMED", checkIn: "2026-10-01", checkOut: "2026-10-04", grossRoomCents: 10000 },
      { ...base, status: "CANCELLED", checkIn: "2026-10-05", checkOut: "2026-10-07", grossRoomCents: 9999 },
      { ...base, status: "DUPLICATE", checkIn: "2026-10-05", checkOut: "2026-10-07", grossRoomCents: 9999 },
      { ...base, status: "BLOCKED", checkIn: "2026-10-08", checkOut: "2026-10-10", grossRoomCents: 0 },
    ]);
    expect(sold.map((n) => n.grossRoomCents)).toEqual(allocate(10000, 3)); // 3 334, 3 333, 3 333
    expect(sold.reduce((a, n) => a + (n.commissionCents ?? 0), 0)).toBe(1001); // somme exacte
    expect(blocked).toEqual(["2026-10-08", "2026-10-09"]);
  });
});

// Propriétés : sur des jeux aléatoires reproductibles, les KPI restent cohérents quelle que soit la découpe de la période.
function prng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
describe("KPI canoniques : propriétés", () => {
  for (const seed of [1, 7, 42, 2026, 99991]) {
    it(`découpe additive et bornes (jeu ${seed})`, () => {
      const rnd = prng(seed);
      const sold: NightFact[] = [], blocked: string[] = [];
      for (let i = 0; i < 400; i++) {
        const d = addDays("2026-01-01", Math.floor(rnd() * 365));
        const r = rnd();
        if (r < 0.1) blocked.push(d);
        else if (r < 0.6) sold.push(night(d, Math.round(5000 + rnd() * 15000), rnd() < 0.8 ? Math.round(rnd() * 3000) : null, rnd() < 0.5 ? "AIRBNB" : "BOOKING", rnd() < 0.3 ? Math.round(rnd() * 300) : null));
      }
      const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
      const whole = computeKpi({ from: "2026-01-01", to: "2027-01-01" }, sold, blocked);
      const parts = kpiByMonth(months, sold, blocked);
      // additivité exacte des montants entiers et des nuits
      expect(parts.reduce((a, k) => a + k.soldNights, 0)).toBe(whole.soldNights);
      expect(parts.reduce((a, k) => a + k.grossRoomCents, 0)).toBe(whole.grossRoomCents);
      expect(parts.reduce((a, k) => a + k.netNights, 0)).toBe(whole.netNights);
      expect(parts.reduce((a, k) => a + (k.netRoomCents ?? 0), 0)).toBe(whole.netRoomCents ?? 0);
      expect(parts.reduce((a, k) => a + k.availableNights, 0)).toBe(whole.availableNights);
      // bornes
      for (const k of [whole, ...parts]) {
        expect(k.availableNights).toBeLessThanOrEqual(k.days);
        expect(k.soldNights).toBeGreaterThanOrEqual(k.overlappingNights);
        if (k.occupancy !== null) { expect(k.occupancy).toBeGreaterThanOrEqual(0); expect(k.occupancy).toBeLessThanOrEqual(1); }
        expect(k.netNights).toBeLessThanOrEqual(k.soldNights);
        // le net d'une période COMPLETE ne dépasse jamais son brut
        if (k.netStatus === "COMPLETE") expect(k.netRoomCents!).toBeLessThanOrEqual(k.grossRoomCents);
        // RevPAN ≤ ADR quand l'occupation ne dépasse pas 100 % (sans double réservation)
        if (k.grossRevpanCents !== null && k.adrCents !== null && k.overlappingNights === 0) expect(k.grossRevpanCents).toBeLessThanOrEqual(k.adrCents + 1);
        expect(k.byChannel.reduce((a, c) => a + c.soldNights, 0)).toBe(k.soldNights);
        expect(k.byChannel.reduce((a, c) => a + c.grossRoomCents, 0)).toBe(k.grossRoomCents);
      }
    });
  }
});
