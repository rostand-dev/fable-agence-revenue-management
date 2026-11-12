import { describe, expect, it } from "vitest";
import { mapChannel, mapListing, mapMarket, mapPrices, mapReservations, percentileOf } from "./pricelabs-map";

// Extraits de la forme réellement renvoyée par l'API (valeurs relevées sur un compte SuperHote).
const prices = { id: "97999683013", pms: "superhote", currency: "EUR", data: [
  { date: "2026-11-13", price: 128, user_price: 130, min_stay: 2, booking_status: "", unbookable: 0, demand_desc: "Low Demand" },
  { date: "2026-11-15", price: 128, user_price: -1, min_stay: 2, booking_status: "Booked (Check-In)", unbookable: 0, demand_desc: "Unavailable" },
  { date: "2026-11-16", price: 128, user_price: -1, min_stay: 2, booking_status: "", unbookable: 1, demand_desc: "Unavailable" },
] };
const market = {
  "Listings Used": 350, "Neighborhood Data Source": "Nearby Listings",
  "Future Percentile Prices": { Labels: ["25th Percentile", "50th Percentile", "75th Percentile", "Median Booked Price", "90th Percentile", "N_Bookings"],
    Category: { "2": { X_values: ["2026-11-13", "2026-11-14", "2026-11-15"], Y_values: [[119.9, 122.6, 122.6], [164, 166.7, 166.7], [190.2, 193.8, 193.8], [161.3, 163.6, 164], [389, 389, 389], [30, 32, 31]] } } },
  "Future Occ/New/Canc": { Labels: ["Occupancy", "New Bookings"],
    // dates décalées par rapport aux prix, et lignes enveloppées dans un tableau supplémentaire
    Category: { "2": { X_values: ["2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"], Y_values: [[[43.5, 46.4, 44.9, 37.9]], [[1, 2, 3, 4]]] }, "-1": { X_values: [], Y_values: [] } } },
};

describe("PriceLabs → modèle interne", () => {
  it("lit la grille : prix publié, nuit réservée, nuit bloquée", () => {
    const d = mapPrices(prices);
    expect(d[0]).toMatchObject({ date: "2026-11-13", state: "FREE", priceCents: 13000, minStay: 2 });
    expect(d[1]).toMatchObject({ state: "BOOKED", priceCents: null });
    expect(d[2]).toMatchObject({ state: "BLOCKED", priceCents: null });
  });
  it("indexe le marché par date, convertit l'occupation 0–100 et situe le prix entre les centiles", () => {
    const { market: m, category, listingsUsed } = mapMarket(market, 2, mapPrices(prices));
    expect(category).toBe("2"); expect(listingsUsed).toBe(350);
    expect(m[0].marketOccupancy).toBe(0.46);          // 13 nov. = 46,4 %, et non la première valeur de la série
    expect(m[0].marketAdrCents).toBe(16130);
    expect(m[0].pricePercentile).toBeGreaterThan(25); expect(m[0].pricePercentile).toBeLessThan(50); // 130 € entre 119,9 et 164
    expect(m[1].pricePercentile).toBeNull();           // nuit réservée : pas de prix, donc position inconnue
  });
  it("marché absent ou catégorie inconnue → valeurs inconnues, jamais zéro", () => {
    expect(mapMarket(null, 2, mapPrices(prices)).market[0]).toMatchObject({ marketOccupancy: null, pricePercentile: null });
    expect(mapMarket(market, 7, mapPrices(prices)).category).toBe("2"); // repli sur une catégorie existante autre que « chambre »
  });
  it("percentileOf borne et interpole", () => {
    expect(percentileOf(100, 120, 160, 190, 380)).toBeLessThan(25);
    expect(percentileOf(160, 120, 160, 190, 380)).toBe(50);
    expect(percentileOf(500, 120, 160, 190, 380)).toBeGreaterThan(90);
    expect(percentileOf(100, null, null, 190, null)).toBeNull();
  });
  it("lit les réservations : annulée, blocage à 0 €, commission fournie, estimée ou inconnue", () => {
    const rows = [
      { reservation_id: "1", check_in: "2026-10-15", check_out: "2026-10-18", booking_status: "canceled", booked_date: "2026-09-09T17:36:43.000Z", rental_revenue: "NA", total_cost: "663.0", no_of_days: 3, booking_channel: "bcom", ota_commission: "112.0", cleaning_fees: 0.0 },
      { reservation_id: "2", check_in: "2026-10-05", check_out: "2026-10-09", booking_status: "booked", booked_date: "2026-09-22T18:08:17.000Z", rental_revenue: "NA", total_cost: "708.0", no_of_days: 4, booking_channel: "airbnb", ota_commission: "0.0" },
      { reservation_id: "3", check_in: "2026-11-01", check_out: "2026-11-03", booking_status: "booked", booked_date: null, rental_revenue: "NA", total_cost: "0.0", no_of_days: 2, booking_channel: "" },
      { reservation_id: "4", check_in: "2026-11-05", check_out: "2026-11-07", booking_status: "booked", booked_date: "2026-10-01T00:00:00Z", rental_revenue: 300, total_cost: "360", no_of_days: 2, booking_channel: "bcom", ota_commission: "51" },
    ];
    const model: any = { channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 } } };
    const r = mapReservations(rows, model);
    expect(r[0]).toMatchObject({ status: "CANCELLED", channel: "BOOKING", commissionCents: 11200 });
    expect(r[1]).toMatchObject({ status: "CONFIRMED", channel: "AIRBNB", grossRoomCents: 70800, commissionCents: 10974, commissionEstimated: true, bookedAt: "2026-09-22" });
    expect(r[2]).toMatchObject({ status: "BLOCKED", bookedAt: "2026-11-01" });
    expect(r[3]).toMatchObject({ grossRoomCents: 30000, commissionCents: 5100, commissionEstimated: false, paymentFeeCents: null });
    expect(mapReservations([rows[1]], null)[0].commissionCents).toBeNull(); // sans taux déclaré : inconnue
  });
  it("lit une annonce et ses bornes, max absent compris", () => {
    expect(mapListing({ id: 9, pms: "superhote", name: "A", min: 95, base: 126, max: null, no_of_bedrooms: 2 })).toMatchObject({ id: "9", minCents: 9500, baseCents: 12600, maxCents: null, bedrooms: 2 });
    expect(mapChannel("bcom")).toBe("BOOKING"); expect(mapChannel("")).toBe("INCONNU");
  });
});
