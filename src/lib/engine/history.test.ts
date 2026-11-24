import { describe, expect, it } from "vitest";
import { addDays, type ISODate } from "../dates";
import { cancelledFromChanges } from "../reservations/cancellations";
import { cancellationStats, paceComparison, type Cancellation } from "./history";
import type { Resa } from "./types";

const TODAY = "2026-11-12";
const resa = (channel: string, bookedAgo: number, nights = 3, status = "CONFIRMED"): Resa => ({ channel, checkIn: addDays(TODAY, 20), checkOut: addDays(TODAY, 20 + nights), nights, grossRoomCents: nights * 10000, commissionCents: 0, paymentFeeCents: 0, bookedAt: addDays(TODAY, -bookedAgo), status });
const canc = (channel: string, agoDays: number, inDays = 10, nights = 3): Cancellation => ({ channel, checkIn: addDays(TODAY, inDays), checkOut: addDays(TODAY, inDays + nights), nights, grossRoomCents: nights * 10000, cancelledAt: addDays(TODAY, -agoDays) });

describe("annulations déduites de l'historique des changements", () => {
  const snap = (status: string) => ({ status, channel: "AIRBNB", checkIn: "2026-12-01", checkOut: "2026-12-04", grossRoomCents: 30000 });
  const row = (id: string, kind: string, before: unknown, after: unknown, at: string) => ({ externalId: id, kind, before, after, createdAt: new Date(at) });
  it("annulation retenue, modification ultérieure sans effet, réactivation retire l'annulation", () => {
    const out = cancelledFromChanges([
      row("a", "CANCELLED", snap("CONFIRMED"), snap("CANCELLED"), "2026-11-10T09:00:00Z"),
      row("a", "MODIFIED", snap("CANCELLED"), snap("CANCELLED"), "2026-11-11T09:00:00Z"),
      row("b", "CANCELLED", snap("CONFIRMED"), snap("CANCELLED"), "2026-11-10T09:00:00Z"),
      row("b", "REACTIVATED", snap("CANCELLED"), snap("CONFIRMED"), "2026-11-11T09:00:00Z"),
      row("c", "CREATED", null, snap("CONFIRMED"), "2026-11-09T09:00:00Z"),
    ]);
    expect(out.map((o) => [o.externalId, o.at])).toEqual([["a", "2026-11-10"]]);
  });
  it("le jour d'annulation est le jour civil de Paris", () => {
    expect(cancelledFromChanges([row("z", "CANCELLED", snap("CONFIRMED"), snap("CANCELLED"), "2026-11-10T23:30:00Z")])[0].at).toBe("2026-11-11");
  });
});

describe("cancellationStats", () => {
  const resas = [resa("AIRBNB", 2), resa("AIRBNB", 5), resa("BOOKING", 8), resa("BOOKING", 30)];
  it("inconnu sans historique, ou quand l'historique commence après la fenêtre : jamais zéro annulation", () => {
    expect(cancellationStats(undefined, null, resas, TODAY, 14)).toBeNull();
    expect(cancellationStats([], null, resas, TODAY, 14)).toBeNull();
    expect(cancellationStats([], { since: addDays(TODAY, -5) }, resas, TODAY, 14)).toBeNull();
    expect(cancellationStats([], { since: addDays(TODAY, -13) }, resas, TODAY, 14)).toBeNull(); // le premier jour d'historique est peut-être partiel
    expect(cancellationStats([], { since: addDays(TODAY, -14) }, resas, TODAY, 14)).not.toBeNull();
    expect(cancellationStats([], { since: addDays(TODAY, -400) }, resas, TODAY, 121)).toBeNull(); // au-delà de la profondeur chargée
  });
  it("historique suffisant sans annulation : zéro, taux nul", () => {
    expect(cancellationStats([], { since: addDays(TODAY, -60) }, resas, TODAY, 14)).toMatchObject({ cancelled: 0, booked: 3, rate: 0 });
  });
  it("compte les annulations de la fenêtre, par canal, taux et nuits rouvertes à venir", () => {
    const s = cancellationStats([canc("AIRBNB", 1), canc("AIRBNB", 3, -1), canc("BOOKING", 40)], { since: addDays(TODAY, -90) }, resas, TODAY, 14)!;
    expect(s.cancelled).toBe(2); expect(s.byChannel).toEqual({ AIRBNB: 2 }); expect(s.cancelledNights).toBe(6);
    expect(s.booked).toBe(3); expect(s.rate).toBeCloseTo(2 / 5);
    expect(s.reopenedNights).toBe(3 + 2); // 3 nuits futures + 2 des 3 nuits (la 1re a eu lieu hier)
  });
  it("aucune réservation ni annulation dans la fenêtre : taux inconnu", () => {
    expect(cancellationStats([], { since: addDays(TODAY, -90) }, [], TODAY, 14)!.rate).toBeNull();
  });
});

describe("annulation à la borne de fenêtre", () => {
  it("une annulation enregistrée à 23 h 30 UTC compte au jour de Paris, donc dans la fenêtre du lendemain", () => {
    const [c] = cancelledFromChanges([{ externalId: "e", kind: "CANCELLED", before: { status: "CONFIRMED", channel: "AIRBNB", checkIn: "2026-12-01", checkOut: "2026-12-03", grossRoomCents: 1 }, after: { status: "CANCELLED" }, createdAt: new Date("2026-11-11T23:30:00Z") }]);
    expect(c.at).toBe("2026-11-12");
    const s = cancellationStats([{ channel: "AIRBNB", checkIn: "2026-12-01", checkOut: "2026-12-03", nights: 2, grossRoomCents: 1, cancelledAt: c.at }], { since: "2026-01-01" }, [], "2026-11-12", 1)!;
    expect(s.cancelled).toBe(1);
  });
});

describe("paceComparison", () => {
  it("inconnu quand l'historique ne couvre pas la référence", () => {
    expect(paceComparison([resa("AIRBNB", 3)], TODAY, 14, 14, addDays(TODAY, -20))).toBeNull();
    expect(paceComparison([], TODAY, 14, 14, null)).toBeNull();
  });
  it("rythme, durée de séjour et mix de canaux : récent contre référence", () => {
    const first = addDays(TODAY, -60);
    const ref = [...Array(6)].map((_, i) => resa("AIRBNB", 15 + i, 4)); // 6 prises en référence, séjours de 4 nuits, 100 % Airbnb
    const rec = [resa("BOOKING", 1, 2), resa("BOOKING", 3, 2), resa("BOOKING", 6, 2)]; // 3 prises récentes, 2 nuits, 100 % Booking
    const p = paceComparison([...ref, ...rec, resa("AIRBNB", 40, 3, "CANCELLED")], TODAY, 14, 14, first)!;
    expect(p.recent.bookings).toBe(3); expect(p.reference.bookings).toBe(6);
    expect(p.bookingRatio).toBeCloseTo(0.5);
    expect(p.losShift).toBe(-2);
    expect(Math.abs(p.channelShift!.delta)).toBe(1); // deux canaux opposés : déplacement total, signe selon le canal retenu
    expect(["AIRBNB", "BOOKING"]).toContain(p.channelShift!.channel);
  });
  it("fenêtres de longueurs différentes : le rapport est ramené à la même longueur", () => {
    const p = paceComparison([resa("AIRBNB", 3), resa("AIRBNB", 20), resa("AIRBNB", 25), resa("AIRBNB", 30)], TODAY, 7, 28, addDays(TODAY, -90))!;
    expect(p.recent.bookings).toBe(1); expect(p.reference.bookings).toBe(3);
    expect(p.bookingRatio).toBeCloseTo(1 / (3 * (7 / 28)));
  });
  it("référence vide : rapport inconnu (pas de division par zéro), durée inconnue sous 3 réservations", () => {
    const p = paceComparison([resa("AIRBNB", 2)], TODAY, 14, 14, addDays(TODAY, -90))!;
    expect(p.bookingRatio).toBeNull(); expect(p.losShift).toBeNull(); expect(p.channelShift).toBeNull();
  });
});
