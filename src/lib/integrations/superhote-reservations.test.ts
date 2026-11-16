import { describe, expect, it } from "vitest";
import type { EconomicModel } from "../engine/types";
import { mapReservation } from "./superhote-map";
import { shReservations } from "./superhote-reservations";

const raw = (o: any = {}) => ({ id: "1", external_id: null, rental_id: "11415273", platform_name: "Airbnb.com", status_label: "CONFIRMED", canceled_at: null, booked_at: "2026-10-23T16:07:10+00:00", checkin: "2026-11-23", checkout: "2026-11-26", nights: 3, ...o });
/** Réponse réelle SuperHote, réservation Airbnb 28653938 (données du voyageur retirées). */
const airbnb = () => mapReservation(raw({
  id: "28653938", external_id: "HM294SCWAK", total_price: 398.63, host_payout: 312.58,
  price_details: [{ type: "daily_price", total: 327 }, { type: "cleaning_fee", total: 57 }, { type: "guest_exclusive_tax_remitted_by_airbnb", total: 14.63 }],
  host_fees: [{ type: "airbnb_host_fee", total: 59.52 }, { type: "value_added_tax_host", total: 11.9 }],
}))!;
/** Réservation Booking réelle 25657302 : commission 17 %, frais de paiement 1,4 %. */
const booking = () => mapReservation(raw({
  id: "25657302", platform_name: "Booking.com", checkin: "2026-09-09", checkout: "2026-09-11", nights: 2, booked_at: "2026-09-09T13:49:10+00:00", total_price: 372.2, host_payout: 267.65,
  price_details: [{ type: "daily_price", total: 328 }, { type: "city_tax", total: 44.2 }], host_fees: [{ type: "host_platform_commission", total: 55.76 }],
}))!;
const direct0 = () => mapReservation(raw({ id: "9", platform_name: "Direct", total_price: 0 }))!;

describe("réservations SuperHote → modèle de l'application", () => {
  it("Airbnb réel : hébergement 327 €, ménage 57 €, commission TTC 71,42 €, date de réservation", () => {
    const [r] = shReservations([airbnb()], null);
    expect(r).toMatchObject({ externalId: "28653938", channel: "AIRBNB", status: "CONFIRMED", grossRoomCents: 32700, cleaningCents: 5700, commissionCents: 7142, bookedAt: "2026-10-23", nights: 3, commissionEstimated: false });
  });
  it("Booking réel : commission 55,76 €, frais de paiement = écart de versement (4,59 €)", () => {
    const [r] = shReservations([booking()], null);
    expect(r).toMatchObject({ channel: "BOOKING", grossRoomCents: 32800, commissionCents: 5576, paymentFeeCents: 459 });
  });
  it("direct à 0 € = blocage propriétaire, sans commission", () => {
    expect(shReservations([direct0()], null)[0]).toMatchObject({ status: "BLOCKED", commissionCents: 0, paymentFeeCents: 0 });
  });
  it("annulée = CANCELLED", () => {
    expect(shReservations([mapReservation(raw({ id: "2", canceled_at: "2026-11-01T00:00:00Z", total_price: 100 }))!], null)[0].status).toBe("CANCELLED");
  });
  it("commission absente : inconnue sans taux déclaré, estimée et signalée avec un taux déclaré", () => {
    const noFees = mapReservation(raw({ id: "3", total_price: 400, price_details: [], host_fees: [] }))!;
    expect(shReservations([noFees], null)[0]).toMatchObject({ commissionCents: null, paymentFeeCents: null, commissionEstimated: false });
    const model = { channels: { AIRBNB: { commissionPct: 18.6, paymentFeePct: 0 } } } as unknown as EconomicModel;
    expect(shReservations([noFees], model)[0]).toMatchObject({ commissionCents: 7440, paymentFeeCents: 0, commissionEstimated: true });
  });
  it("écarte le reliquat quand deux réservations confirmées se chevauchent (la plus récente gagne)", () => {
    const a = mapReservation(raw({ id: "old", booked_at: "2026-01-01T00:00:00Z", total_price: 300 }))!, b = mapReservation(raw({ id: "new", booked_at: "2026-02-01T00:00:00Z", total_price: 300 }))!;
    const r = shReservations([a, b], null);
    expect(r.find((x) => x.externalId === "old")?.status).toBe("DUPLICATE");
    expect(r.find((x) => x.externalId === "new")?.status).toBe("CONFIRMED");
  });
  it("nuits absentes : déduites des dates", () => {
    expect(shReservations([mapReservation(raw({ id: "4", nights: 0, total_price: 200 }))!], null)[0].nights).toBe(3);
  });
});
