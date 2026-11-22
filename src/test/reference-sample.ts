import type { Snap } from "@/lib/reservations/nights";

/**
 * Échantillon de référence synthétique (US-054) : 12 réservations confirmées, septembre et octobre 2026, Airbnb (15 %, sans frais de paiement)
 * et Booking.com (17 % + 1 % de frais de paiement). Tous les montants ont été calculés à la main ; ils ne sortent d'aucune fonction de l'application.
 * `sourceNetRoomCents` est le net du relevé du canal : égal au net calculé, sauf deux lignes où le relevé s'écarte de moins de 0,5 %.
 */
export type RefResa = Pick<Snap, "channel" | "checkIn" | "checkOut" | "grossRoomCents" | "commissionCents" | "paymentFeeCents"> & { id: string; nights: number; sourceNetRoomCents: number };
export const REFERENCE_SAMPLE: RefResa[] = [
  { id: "R01", channel: "AIRBNB", checkIn: "2026-09-01", checkOut: "2026-09-03", nights: 2, grossRoomCents: 16000, commissionCents: 2400, paymentFeeCents: null, sourceNetRoomCents: 13600 },
  { id: "R02", channel: "BOOKING", checkIn: "2026-09-05", checkOut: "2026-09-08", nights: 3, grossRoomCents: 33000, commissionCents: 5610, paymentFeeCents: 330, sourceNetRoomCents: 27060 },
  { id: "R03", channel: "AIRBNB", checkIn: "2026-09-10", checkOut: "2026-09-17", nights: 7, grossRoomCents: 70000, commissionCents: 10500, paymentFeeCents: null, sourceNetRoomCents: 59500 },
  { id: "R04", channel: "BOOKING", checkIn: "2026-09-20", checkOut: "2026-09-22", nights: 2, grossRoomCents: 24000, commissionCents: 4080, paymentFeeCents: 240, sourceNetRoomCents: 19680 },
  { id: "R05", channel: "AIRBNB", checkIn: "2026-10-01", checkOut: "2026-10-04", nights: 3, grossRoomCents: 30000, commissionCents: 4500, paymentFeeCents: null, sourceNetRoomCents: 25500 },
  { id: "R06", channel: "AIRBNB", checkIn: "2026-10-05", checkOut: "2026-10-07", nights: 2, grossRoomCents: 18000, commissionCents: 2700, paymentFeeCents: null, sourceNetRoomCents: 15300 },
  { id: "R07", channel: "AIRBNB", checkIn: "2026-10-08", checkOut: "2026-10-15", nights: 7, grossRoomCents: 63000, commissionCents: 9450, paymentFeeCents: null, sourceNetRoomCents: 53550 },
  { id: "R08", channel: "BOOKING", checkIn: "2026-10-16", checkOut: "2026-10-18", nights: 2, grossRoomCents: 22000, commissionCents: 3740, paymentFeeCents: 220, sourceNetRoomCents: 18100 }, // net calculé 18 040 : relevé +0,33 %
  { id: "R09", channel: "BOOKING", checkIn: "2026-10-18", checkOut: "2026-10-25", nights: 7, grossRoomCents: 77000, commissionCents: 13090, paymentFeeCents: 770, sourceNetRoomCents: 63140 },
  { id: "R10", channel: "AIRBNB", checkIn: "2026-10-25", checkOut: "2026-10-27", nights: 2, grossRoomCents: 17000, commissionCents: 2550, paymentFeeCents: null, sourceNetRoomCents: 14450 },
  { id: "R11", channel: "BOOKING", checkIn: "2026-10-27", checkOut: "2026-10-29", nights: 2, grossRoomCents: 21000, commissionCents: 3570, paymentFeeCents: 210, sourceNetRoomCents: 17300 }, // net calculé 17 220 : relevé +0,46 %
  { id: "R12", channel: "AIRBNB", checkIn: "2026-10-29", checkOut: "2026-10-31", nights: 2, grossRoomCents: 19000, commissionCents: 2850, paymentFeeCents: null, sourceNetRoomCents: 16150 },
];

/**
 * Valeurs attendues, calculées à la main (septembre + octobre 2026 = 61 jours, aucune nuit bloquée) :
 * nuits vendues 14 + 27 = 41 ; hébergement 143 000 + 267 000 = 410 000 ; net calculé 119 840 + 223 350 = 343 190.
 * ADR 410 000 / 41 = 10 000 ; Net ADR 343 190 / 41 = 8 370,49 → 8 370 ; RevPAN 410 000 / 61 = 6 721,3 → 6 721 ; Net RevPAN 343 190 / 61 = 5 626,1 → 5 626.
 * Octobre seul : 27 nuits, 267 000, net 223 350, ADR 9 888,9 → 9 889, Net ADR 8 272,2 → 8 272, occupation 27 / 31.
 */
export const REFERENCE_EXPECTED = {
  period: { from: "2026-09-01", to: "2026-11-01" }, october: { from: "2026-10-01", to: "2026-11-01" },
  soldNights: 41, grossRoomCents: 410000, netRoomCents: 343190, adrCents: 10000, netAdrCents: 8370, grossRevpanCents: 6721, netRevpanCents: 5626, days: 61,
  octoberSoldNights: 27, octoberGross: 267000, octoberNet: 223350, octoberAdr: 9889, octoberNetAdr: 8272,
  airbnbNights: 25, airbnbGross: 233000, bookingNights: 16, bookingGross: 177000,
} as const;
