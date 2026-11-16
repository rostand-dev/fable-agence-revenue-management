/**
 * Réservations enregistrées dans NuitSignal, construites depuis SuperHote (source de vérité des réservations et des montants).
 * PriceLabs ne sert plus qu'aux prix, au marché et aux réglages : il relaie les réservations du PMS avec des montants arrondis,
 * sans commission Airbnb récente, des doublons et des réservations manquantes (constaté sur les données réelles, 16/11/2026).
 *
 * Montants (centimes), validés sur l'API réelle :
 * - `grossRoomCents` : hébergement hors ménage et hors taxe de séjour = total payé − taxe de séjour − ménage ;
 * - `commissionCents` : total des lignes `host_fees` (commission TTC, TVA hôte comprise) ;
 * - `paymentFeeCents` (Booking.com) : écart de versement = total − taxe − commission − versement hôte, quand il est plausible (0 à 5 %).
 * Un montant que SuperHote ne fournit pas reste inconnu (null), ou est estimé au taux déclaré par le propriétaire et signalé comme tel.
 */
import { diffDays } from "../dates";
import type { EconomicModel } from "../engine/types";
import { dedupeConfirmed, type PlReservation } from "./pricelabs-map";
import type { ShReservation } from "./superhote-map";

const MAX_PAYMENT_FEE_PCT = 5;

export function shReservations(rows: ShReservation[], model: EconomicModel | null): PlReservation[] {
  const out: PlReservation[] = [];
  for (const r of rows) {
    const channel = r.channel ?? (r.platformName ? r.platformName.trim().toUpperCase().slice(0, 24) : "INCONNU");
    const total = r.totalCents ?? 0;
    // une réservation confirmée à 0 € est un blocage propriétaire (nuits retirées du disponible)
    const status: PlReservation["status"] = r.canceled ? "CANCELLED" : total <= 0 ? "BLOCKED" : "CONFIRMED";
    const tax = r.cityTaxCents ?? 0, cleaning = r.cleaningCents ?? 0;
    const gross = Math.max(0, total - tax - cleaning);
    const rate = model?.channels?.[channel as "AIRBNB" | "BOOKING"];
    const given = (r.hostFeesCents ?? 0) > 0 ? r.hostFeesCents! : null;
    const base = total - tax;
    const gap = r.hostPayoutCents !== null && given !== null ? base - given - r.hostPayoutCents : null;
    const exactPaymentFee = channel === "BOOKING" && gap !== null && gap > 0 && base > 0 && gap / base <= MAX_PAYMENT_FEE_PCT / 100 ? gap : null;
    out.push({
      externalId: r.id, channel, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights > 0 ? r.nights : Math.max(1, diffDays(r.checkOut, r.checkIn)),
      grossRoomCents: gross, cleaningCents: r.cleaningCents,
      // une réservation en direct ne supporte aucune commission de plateforme
      commissionCents: channel === "DIRECT" ? 0 : given !== null ? given : rate && status === "CONFIRMED" ? Math.round(gross * rate.commissionPct / 100) : null,
      paymentFeeCents: channel === "DIRECT" ? 0 : exactPaymentFee !== null ? exactPaymentFee : rate && status === "CONFIRMED" ? Math.round(gross * rate.paymentFeePct / 100) : null,
      status, bookedAt: r.bookedAt ?? r.checkIn, commissionEstimated: channel !== "DIRECT" && given === null && !!rate && status === "CONFIRMED",
    });
  }
  return dedupeConfirmed(out);
}
