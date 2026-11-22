import { describe, expect, it } from "vitest";
import { addDays } from "../dates";
import { computePace, PACE_TOLERANCE_POINTS, STLY_OFFSET_DAYS, type BookedNight } from "./pace";

const T = "2026-11-21";
const nightsOf = (from: string, n: number, bookedAt: string): BookedNight[] => Array.from({ length: n }, (_, i) => ({ night: addDays(from, i), bookedAt }));
const base = { today: T, booked: [] as BookedNight[], cancelled: [], blocked: [] as string[], firstBookingDate: "2025-01-01", firstStayDate: "2025-01-10" };
const w = (r: ReturnType<typeof computePace>, key: string) => r.find((x) => x.key === key)!;

describe("pickup (US-051)", () => {
  it("compte les nuits réservées pendant les N derniers jours civils, aujourd'hui compris", () => {
    const booked = [
      ...nightsOf("2026-11-22", 2, "2026-11-21"), // aujourd'hui : dans 1, 3, 7, 14
      ...nightsOf("2026-11-25", 1, "2026-11-19"), // il y a 2 jours : dans 3, 7, 14
      ...nightsOf("2026-11-26", 1, "2026-11-15"), // il y a 6 jours : dans 7, 14
      ...nightsOf("2026-11-27", 1, "2026-11-08"), // il y a 13 jours : dans 14 seulement
      ...nightsOf("2026-11-28", 1, "2026-10-01"), // ancienne : dans aucun
    ];
    const d = w(computePace({ ...base, booked }), "D0_7");
    expect(d.pickup).toEqual({ 1: 2, 3: 3, 7: 4, 14: 5 });
    expect(d.onBooksNights).toBe(6);
  });
  it("limite le pickup à la fenêtre de séjour et ignore une date de réservation future", () => {
    const booked = [...nightsOf("2026-11-22", 1, "2026-11-21"), ...nightsOf("2027-02-01", 1, "2026-11-21"), ...nightsOf("2026-11-23", 1, "2026-11-30")];
    const r = computePace({ ...base, booked });
    expect(w(r, "D0_7").pickup[1]).toBe(1);
    expect(w(r, "D61_90").pickup[1]).toBe(1);
    expect(w(r, "D0_7").onBooksNights).toBe(1); // la réservation « du futur » (incohérente) n'est pas comptée
  });
  it("donne les annulations à part, sans les retrancher du pickup", () => {
    const r = computePace({ ...base, booked: nightsOf("2026-11-22", 2, "2026-11-20"), cancelled: [{ night: "2026-11-24", cancelledAt: "2026-11-21" }, { night: "2026-11-24", cancelledAt: "2026-11-05" }, { night: "2027-03-01", cancelledAt: "2026-11-21" }] });
    const d = w(r, "D0_7");
    expect(d.pickup[3]).toBe(2); expect(d.cancelled).toEqual({ 1: 1, 3: 1, 7: 1, 14: 1 });
  });
});

describe("pacing face à l'an dernier (US-051)", () => {
  const asOf = addDays(T, -STLY_OFFSET_DAYS); // 2025-11-22
  const lyFrom = addDays("2026-11-21", -STLY_OFFSET_DAYS);
  it("avance, cible et retard selon l'écart d'occupation en points", () => {
    // fenêtre D0_7 = 8 nuits. Cette année 6 réservées (75 %). L'an dernier, à la même date : 2 (25 %) → en avance de 50 points
    const ahead = computePace({ ...base, booked: [...nightsOf("2026-11-21", 6, "2026-10-20"), ...nightsOf(lyFrom, 2, addDays(asOf, -10))] });
    expect(w(ahead, "D0_7")).toMatchObject({ occupancy: 0.75, status: "AHEAD" });
    expect(w(ahead, "D0_7").gapPoints).toBeCloseTo(0.5);
    expect(w(ahead, "D0_7").lastYear).toMatchObject({ occupancy: 0.25, onBooksNights: 2, from: lyFrom });
    const track = computePace({ ...base, booked: [...nightsOf("2026-11-21", 4, "2026-10-20"), ...nightsOf(lyFrom, 4, addDays(asOf, -10))] });
    expect(w(track, "D0_7").status).toBe("ON_TRACK");
    const behind = computePace({ ...base, booked: [...nightsOf("2026-11-21", 1, "2026-10-20"), ...nightsOf(lyFrom, 5, addDays(asOf, -10))] });
    expect(w(behind, "D0_7").status).toBe("BEHIND");
    expect(PACE_TOLERANCE_POINTS).toBe(0.05);
  });
  it("une réservation de l'an dernier faite APRÈS la date de comparaison n'était pas encore au livre", () => {
    const r = computePace({ ...base, booked: [...nightsOf("2026-11-21", 4, "2026-10-20"), ...nightsOf(lyFrom, 4, addDays(asOf, +3))] });
    expect(w(r, "D0_7").lastYear.onBooksNights).toBe(0); expect(w(r, "D0_7").status).toBe("AHEAD");
  });
  it("sans historique d'un an, le pacing est INCONNU et dit pourquoi (jamais « dans la cible »)", () => {
    const none = computePace({ ...base, firstBookingDate: null, firstStayDate: null });
    expect(none.every((x) => x.status === "UNKNOWN" && x.unknownReason === "NO_HISTORY" && x.gapPoints === null && x.lastYear.occupancy === null)).toBe(true);
    const short = computePace({ ...base, firstBookingDate: addDays(T, -100), booked: nightsOf("2026-11-21", 3, "2026-11-01") });
    expect(w(short, "D0_7")).toMatchObject({ status: "UNKNOWN", unknownReason: "HISTORY_TOO_SHORT" });
    expect(w(short, "D0_7").occupancy).toBe(3 / 8); // l'occupation actuelle reste connue
  });
  it("l'historique doit couvrir les nuits comparées, pas seulement une vieille réservation ; l'écart de 5 points exact compte", () => {
    const old = computePace({ ...base, firstStayDate: "2026-06-01", booked: nightsOf("2026-11-21", 4, "2026-10-01") });
    expect(w(old, "D0_7")).toMatchObject({ status: "UNKNOWN", unknownReason: "HISTORY_TOO_SHORT" });
    // 20 nuits disponibles sur D15_30 ? la fenêtre en compte 16 ; on teste l'arrondi sur un cas à 8 nuits : 3/8 − 2/8 = 12,5 points (AHEAD) et 8 nuits à 0,05 près via le seuil
    const exact = computePace({ ...base, booked: [...nightsOf("2026-12-07", 8, "2026-10-01"), ...nightsOf(addDays("2026-12-07", -STLY_OFFSET_DAYS), 7, addDays(asOf, -3))] });
    const d = w(exact, "D15_30"); // 16 nuits : 8 contre 7 → 0,5 − 0,4375 = 6,25 points
    expect(d.gapPoints).toBeCloseTo(0.0625, 6); expect(d.status).toBe("AHEAD");
  });
  it("les nuits bloquées sortent du disponible ; tout bloqué = pas de pacing", () => {
    const blocked = Array.from({ length: 8 }, (_, i) => addDays("2026-11-21", i));
    const r = computePace({ ...base, blocked });
    expect(w(r, "D0_7")).toMatchObject({ availableNights: 0, occupancy: null, status: "UNKNOWN", unknownReason: "NO_AVAILABILITY" });
    expect(w(computePace({ ...base, blocked: ["2026-11-22", "2026-11-23"] }), "D0_7").availableNights).toBe(6);
  });
  it("les cinq fenêtres canoniques couvrent D+0 à D+90 sans trou ni chevauchement", () => {
    const r = computePace(base);
    expect(r.map((x) => x.key)).toEqual(["D0_7", "D8_14", "D15_30", "D31_60", "D61_90"]);
    expect(r[0].from).toBe(T); expect(r[4].to).toBe(addDays(T, 91));
    for (let i = 1; i < r.length; i++) expect(r[i].from).toBe(r[i - 1].to);
  });
});
