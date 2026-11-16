import { describe, expect, it } from "vitest";
import { channelHints, compareReservations, comparePriceSeries, lastPage, listOf, mapCalendar, mapPlatform, mapRental, mapReservation, observedCommission, ShapeError, unwrap } from "./superhote-map";

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

/** Réponse réelle SuperHote pour la réservation Airbnb 28653938 (données du voyageur retirées) : host_fees en montants positifs, TVA hôte en ligne séparée. */
const money = (o: any = {}) => resa({
  id: "28653938", external_id: "HM294SCWAK", checkin: "2026-11-23", checkout: "2026-11-26", nights: 3,
  total_price: 398.63, fare_accommodation: 327, host_payout: 312.58, payment_status: "MANAGED_BY_PLATFORM",
  price_details: [{ type: "daily_price", total: 327, vat_rate: 0 }, { type: "cleaning_fee", total: 57, vat_rate: 0 }, { type: "guest_exclusive_tax_remitted_by_airbnb", label: "Taxe de séjour", total: 14.63, vat_rate: 0 }],
  host_fees: [{ type: "airbnb_host_fee", label: "Frais Airbnb hôte", total: 59.52, vat_rate: 0 }, { type: "value_added_tax_host", label: "TVA hôte", total: 11.9, vat_rate: 0 }], ...o,
});

describe("montants d'une réservation", () => {
  it("lit total, versement, taxe de séjour, ménage et frais hôte (positifs) en centimes", () => {
    expect(mapReservation(money())).toMatchObject({ totalCents: 39863, hostPayoutCents: 31258, cityTaxCents: 1463, cleaningCents: 5700, hostFeesCents: 7142 });
    expect(mapReservation(money())!.feeLines[1]).toEqual({ type: "value_added_tax_host", label: "TVA hôte", cents: 1190, vatRate: 0 });
  });
  it("reconnaît aussi la taxe de séjour `city_tax` (doc) et des frais négatifs", () => {
    const r = mapReservation(money({ price_details: [{ type: "city_tax", total: 14.63 }], host_fees: [{ type: "x", total: -59.52 }, { type: "y", total: -11.9 }] }))!;
    expect(r).toMatchObject({ cityTaxCents: 1463, hostFeesCents: 7142 });
  });
  it("montants absents = inconnus (null), jamais 0", () => {
    expect(mapReservation(resa())).toMatchObject({ totalCents: null, hostPayoutCents: null, cityTaxCents: null, cleaningCents: null, hostFeesCents: null });
  });
});

describe("taux de commission relevé chez SuperHote", () => {
  it("cas réel 28653938 : (59,52 + 11,90) ÷ (398,63 − 14,63) = 18,6 %, avec la période", () => {
    expect(observedCommission([mapReservation(money())!]).AIRBNB).toEqual({ pct: 18.6, n: 1, from: "2026-11-23", to: "2026-11-23", excluded: 0 });
  });
  it("ne compte pas deux fois la commission : host_platform_commission fait foi seul (cas réel 24586125, 18,6 %)", () => {
    const r = mapReservation(resa({ id: "24586125", total_price: 368.63, host_payout: 288.16, price_details: [{ type: "guest_exclusive_tax_remitted_by_airbnb", total: 14.63 }], host_fees: [{ type: "host_platform_commission", total: 65.84 }, { type: "airbnb_host_fee", total: 54.87 }, { type: "value_added_tax_host", total: 10.97 }] }))!;
    expect(r.hostFeesCents).toBe(6584);
    expect(observedCommission([r]).AIRBNB?.pct).toBe(18.6);
  });
  it("ne contrôle pas le versement : sur Booking il retire d'autres frais (cas réel 25657302, 17,0 %)", () => {
    const b = mapReservation(resa({ id: "25657302", platform_name: "Booking.com", total_price: 372.2, host_payout: 267.65, price_details: [{ type: "city_tax", total: 44.2 }], host_fees: [{ type: "host_platform_commission", total: 55.76 }] }))!;
    expect(observedCommission([b]).BOOKING).toMatchObject({ pct: 17, n: 1, excluded: 0 });
  });
  it("écarte un taux invraisemblable (> 40 %) et le compte", () => {
    const bad = mapReservation(money({ id: "902", host_fees: [{ type: "airbnb_host_fee", total: 250 }] }))!;
    expect(observedCommission([mapReservation(money())!, bad]).AIRBNB).toMatchObject({ n: 1, excluded: 1 });
  });
  it("ignore annulées, sans frais, sans total et canaux hors Airbnb/Booking", () => {
    const rows = [mapReservation(money({ canceled_at: "2026-11-01T00:00:00Z" }))!, mapReservation(money({ id: "3", host_fees: [] }))!, mapReservation(money({ id: "4", total_price: null }))!, mapReservation(money({ id: "5", platform_name: "Direct" }))!, mapReservation(resa({ id: "6" }))!];
    expect(observedCommission(rows)).toEqual({});
  });
  it("sépare Airbnb et Booking", () => {
    const r = observedCommission([mapReservation(money())!, mapReservation(money({ id: "7", platform_name: "Booking.com" }))!]);
    expect(Object.keys(r).sort()).toEqual(["AIRBNB", "BOOKING"]);
  });
});

describe("contrôle croisé réservations SuperHote / PriceLabs", () => {
  const sh = [mapReservation(money({ id: "901" }))!, mapReservation(money({ id: "902", total_price: 300 }))!, mapReservation(money({ id: "903" }))!];
  const pl = (id: string, total: string, status = "booked") => ({ reservation_id: id, booking_status: status, total_cost: total });
  it("concordantes à 1 € près (PriceLabs arrondit à l'euro)", () => {
    expect(compareReservations([sh[0]], [pl("901", "398.0")])).toMatchObject({ compared: 1, amountDiffs: 0, onlySuperhote: 0, onlyPriceLabs: 0 });
  });
  it("signale montant différent, absente de PriceLabs et absente de SuperHote", () => {
    const r = compareReservations(sh, [pl("901", "398.0"), pl("902", "250.0"), pl("999", "100.0"), pl("888", "50.0", "canceled")]);
    expect(r).toMatchObject({ compared: 2, amountDiffs: 1, onlySuperhote: 1, onlyPriceLabs: 1 });
    expect(r.samples.map((x) => x.kind).sort()).toEqual(["ABSENTE_PRICELABS", "ABSENTE_SUPERHOTE", "MONTANT"]);
  });
});
