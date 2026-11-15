import { describe, expect, it } from "vitest";
import { channelHints, comparePriceSeries, lastPage, listOf, mapCalendar, mapPlatform, mapRental, mapReservation, ShapeError, unwrap } from "./superhote-map";

const resa = (o: any = {}) => ({ id: "901", external_id: "HM123", rental_id: "12345", platform_name: "Airbnb.com", status_label: "CONFIRMED", canceled_at: null, checkin: "2026-12-03", checkout: "2026-12-06", nights: 3, ...o });

describe("enveloppe et pagination", () => {
  it("lit result et meta.last_page dans result", () => {
    const j = { success: true, message: null, result: { items: [{ id: 1 }], meta: { total: 150, per_page: 100, current_page: 1, last_page: 2 } } };
    expect(listOf(unwrap(j))).toHaveLength(1);
    expect(lastPage(j)).toBe(2);
  });
  it("accepte un tableau direct ou une unique propriété tableau", () => {
    expect(listOf([{ a: 1 }])).toHaveLength(1);
    expect(listOf({ nuits: [{ a: 1 }], meta: {} })).toHaveLength(1);
  });
  it("signale une forme inconnue au lieu de deviner", () => {
    expect(() => listOf({ a: [1], b: [2] })).toThrow(ShapeError);
    expect(() => listOf(null)).toThrow(ShapeError);
  });
});

describe("mapping", () => {
  it("logement : id texte, ville, devise", () => {
    expect(mapRental({ id: "12345", name: "T3 Châtillon", city: "Châtillon", capacity: 4, currency: "EUR", enabled: true })).toMatchObject({ id: "12345", city: "Châtillon" });
    expect(mapRental({ id: "1" })).toBeNull();
  });
  it("plateformes : connues mappées, inconnues laissées inconnues", () => {
    expect(mapPlatform("Airbnb.com")).toBe("AIRBNB");
    expect(mapPlatform("Booking.com")).toBe("BOOKING");
    expect(mapPlatform("Direct")).toBe("DIRECT");
    expect(mapPlatform("Expedia")).toBeNull();
    expect(mapPlatform(null)).toBeNull();
  });
  it("réservation : annulée par canceled_at ou statut", () => {
    expect(mapReservation(resa())?.canceled).toBe(false);
    expect(mapReservation(resa({ canceled_at: "2026-11-01T10:00:00Z" }))?.canceled).toBe(true);
    expect(mapReservation(resa({ status_label: "CANCELED_BY_TRAVELER" }))?.canceled).toBe(true);
    expect(mapReservation({ id: 1 })).toBeNull();
  });
  it("calendrier : prix en euros → centimes, null conservé", () => {
    const n = mapCalendar([{ date: "2026-07-01", available: true, price: 135.5, reservation_id: null }, { date: "2026-07-02", available: true, price: null }, { date: "2026-07-03", available: false, price: 99, reservation_id: "901" }]);
    expect(n.map((x) => x.priceCents)).toEqual([13550, null, 9900]);
    expect(n[2]).toMatchObject({ available: false, reservationId: "901" });
  });
});

describe("canal des réservations transmises sans canal", () => {
  const sh = [mapReservation(resa())!, mapReservation(resa({ id: "902", external_id: null, platform_name: "Booking.com", checkin: "2026-12-10", checkout: "2026-12-12" }))!];
  const none = (c: unknown) => typeof c === "string" && c.trim() !== "";
  it("rapproche par identifiant puis par dates uniques", () => {
    const h = channelHints([{ reservation_id: "HM123", check_in: "2026-12-03", check_out: "2026-12-06", booking_channel: "" }, { reservation_id: "X", check_in: "2026-12-10", check_out: "2026-12-12", booking_channel: null }], sh, none);
    expect(h).toEqual({ HM123: "AIRBNB", X: "BOOKING" });
  });
  it("ne touche pas aux réservations dont le canal est déjà connu", () => {
    expect(channelHints([{ reservation_id: "HM123", check_in: "2026-12-03", check_out: "2026-12-06", booking_channel: "airbnb" }], sh, none)).toEqual({});
  });
  it("ne tranche jamais une ambiguïté de dates ni une annulée", () => {
    const amb = [mapReservation(resa({ id: "1", external_id: null }))!, mapReservation(resa({ id: "2", external_id: null, platform_name: "Booking.com" }))!];
    expect(channelHints([{ reservation_id: "Z", check_in: "2026-12-03", check_out: "2026-12-06" }], amb, none)).toEqual({});
    const canc = [mapReservation(resa({ canceled_at: "2026-11-01T00:00:00Z" }))!];
    expect(channelHints([{ reservation_id: "HM123", check_in: "2026-12-03", check_out: "2026-12-06" }], canc, none)).toEqual({});
  });
});

describe("comparaison avec le prix envoyé par PriceLabs", () => {
  const sent = (d: string, c: number | null, state = "FREE") => ({ date: d, sentPriceCents: c, state });
  it("identique : le prix SuperHote est le prix avant majoration", () => {
    const r = comparePriceSeries(mapCalendar([{ date: "2026-12-01", price: 120 }, { date: "2026-12-02", price: 121 }]), [sent("2026-12-01", 12000), sent("2026-12-02", 12050)]);
    expect(r).toMatchObject({ compared: 2, differing: 0, verdict: "IDENTIQUE" });
  });
  it("écart : repère les nuits qui diffèrent au-delà de 1 €", () => {
    const r = comparePriceSeries(mapCalendar([{ date: "2026-12-01", price: 132 }]), [sent("2026-12-01", 12000)]);
    expect(r).toMatchObject({ differing: 1, verdict: "ECART", maxGapCents: 1200 });
    expect(r.samples[0]).toEqual({ date: "2026-12-01", shCents: 13200, sentCents: 12000 });
  });
  it("ignore nuits réservées, indisponibles ou sans prix ; rien à comparer = inconnu", () => {
    const sh = mapCalendar([{ date: "2026-12-01", price: 100, reservation_id: "9" }, { date: "2026-12-02", price: 100, available: false }, { date: "2026-12-03", price: null }]);
    const r = comparePriceSeries(sh, [sent("2026-12-01", 10000), sent("2026-12-02", 10000), sent("2026-12-03", 10000), sent("2026-12-04", 10000, "BOOKED")]);
    expect(r).toMatchObject({ compared: 0, verdict: "INCONNU" });
  });
});
