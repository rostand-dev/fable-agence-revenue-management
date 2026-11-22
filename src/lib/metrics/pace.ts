/**
 * Pickup et pacing par horizon (US-051, blueprint §7.2, §7.3, §5.2). Module pur, aucun accès base.
 *
 * - **Pickup N jours** : nuits de la fenêtre de séjour dont la réservation a été faite pendant les N derniers jours civils, aujourd'hui compris
 *   (N = 1, 3, 7, 14). Les annulations des mêmes N jours sont données à part (`cancelled`), jamais retranchées en silence : une réservation faite
 *   puis annulée dans la période n'apparaît pas dans le pickup (elle n'a plus de nuits) mais apparaît dans les annulations.
 * - **Pacing** : nuits déjà réservées d'une fenêtre à venir, comparées à la même fenêtre un an plus tôt (52 semaines, pour garder les jours de semaine)
 *   au même délai avant le séjour. Sans historique suffisant, le pacing est INCONNU, jamais « dans la cible ».
 * - Les fenêtres sont les cinq fenêtres canoniques du blueprint §7.3 (D+0–7, D+8–14, D+15–30, D+31–60, D+61–90).
 * Les annulations sont datées de leur ENREGISTREMENT chez nous (date de lecture), pas de la date indiquée par la source : « annulations connues pendant les N derniers jours ».
 * Limites assumées : les blocages du calendrier lu n'existent qu'à partir d'aujourd'hui, donc la disponibilité de l'an dernier est surévaluée si le propriétaire bloquait par le calendrier (le pacing penche alors vers « en retard » à tort ou « en avance » selon le cas) ; une réservation annulée n'a plus de nuits, donc le même-jour-l'an-dernier est sous-évalué des annulations tardives ;
 * les annulations ne sont connues que depuis la mise en route de l'ingestion SuperHote.
 */
import { addDays, diffDays, type ISODate } from "../dates";
import { WINDOWS } from "../engine/metrics";

export const PICKUP_LOOKBACKS = [1, 3, 7, 14] as const;
export type Lookback = (typeof PICKUP_LOOKBACKS)[number];
/** Décalage de la comparaison : 52 semaines. */
export const STLY_OFFSET_DAYS = 364;
/** Écart (en points d'occupation) au-delà duquel on parle d'avance ou de retard. */
export const PACE_TOLERANCE_POINTS = 0.05;

export type BookedNight = { night: ISODate; bookedAt: ISODate };
export type CancelledNight = { night: ISODate; cancelledAt: ISODate };
export type PaceStatus = "AHEAD" | "ON_TRACK" | "BEHIND" | "UNKNOWN";
export type PaceReason = "NO_HISTORY" | "HISTORY_TOO_SHORT" | "NO_AVAILABILITY" | null;

export type WindowPace = {
  key: string; label: string; from: ISODate; to: ISODate;
  availableNights: number; onBooksNights: number; occupancy: number | null;
  pickup: Record<Lookback, number>; cancelled: Record<Lookback, number>;
  /** Même fenêtre un an plus tôt, au même délai : occupation déjà réservée à l'époque (null = inconnue). */
  lastYear: { from: ISODate; to: ISODate; occupancy: number | null; onBooksNights: number | null };
  /** Occupation actuelle − occupation un an plus tôt, en points (0,05 = 5 points) ; null = inconnu. */
  gapPoints: number | null;
  status: PaceStatus; unknownReason: PaceReason;
};

export type PaceInput = {
  today: ISODate;
  /** Nuits vendues aujourd'hui, avec la date de leur réservation. */
  booked: BookedNight[];
  /** Nuits d'annulations connues. */
  cancelled: CancelledNight[];
  /** Dates bloquées par le propriétaire (aujourd'hui et un an plus tôt). */
  blocked: ISODate[];
  /** Date de la plus ancienne réservation connue : sans elle, ou plus récente que la date de comparaison, le pacing est inconnu. */
  firstBookingDate: ISODate | null;
  /** Première nuit de séjour connue : l'historique doit aussi couvrir les nuits comparées (une réservation ancienne pour un séjour lointain ne prouve pas qu'on a lu l'an dernier). */
  firstStayDate: ISODate | null;
};

const within = (d: ISODate, from: ISODate, to: ISODate) => d >= from && d < to;

export function computePace(i: PaceInput): WindowPace[] {
  const asOfLastYear = addDays(i.today, -STLY_OFFSET_DAYS);
  return WINDOWS.map((w) => {
    const from = addDays(i.today, w.from), to = addDays(i.today, w.to + 1), days = diffDays(to, from);
    const inWin = i.booked.filter((b) => within(b.night, from, to) && b.bookedAt <= i.today);
    const bookedDates = new Set(inWin.map((b) => b.night));
    const blockedOnly = new Set(i.blocked.filter((d) => within(d, from, to) && !bookedDates.has(d)));
    const available = days - blockedOnly.size;
    const pickup = {} as Record<Lookback, number>, cancelled = {} as Record<Lookback, number>;
    for (const n of PICKUP_LOOKBACKS) {
      const since = addDays(i.today, -n + 1);
      pickup[n] = inWin.filter((b) => b.bookedAt >= since).length;
      cancelled[n] = i.cancelled.filter((c) => within(c.night, from, to) && c.cancelledAt >= since && c.cancelledAt <= i.today).length;
    }
    const occupancy = available > 0 ? bookedDates.size / available : null;

    // même fenêtre un an plus tôt, vue telle qu'elle était à la date de comparaison
    const lyFrom = addDays(from, -STLY_OFFSET_DAYS), lyTo = addDays(to, -STLY_OFFSET_DAYS);
    const lyBooked = new Set(i.booked.filter((b) => within(b.night, lyFrom, lyTo) && b.bookedAt <= asOfLastYear).map((b) => b.night));
    const lyBlocked = new Set(i.blocked.filter((d) => within(d, lyFrom, lyTo) && !lyBooked.has(d)));
    const lyAvailable = days - lyBlocked.size;
    let reason: PaceReason = null;
    if (i.firstBookingDate === null || i.firstStayDate === null) reason = "NO_HISTORY";
    else if (i.firstBookingDate > asOfLastYear || i.firstStayDate > lyFrom) reason = "HISTORY_TOO_SHORT";
    else if (available <= 0 || lyAvailable <= 0) reason = "NO_AVAILABILITY";
    const lyOcc = reason === null ? lyBooked.size / lyAvailable : null;
    const gap = reason === null && occupancy !== null && lyOcc !== null ? Math.round((occupancy - lyOcc) * 1e6) / 1e6 : null; // arrondi : 0,35 − 0,30 doit valoir exactement 5 points
    const status: PaceStatus = gap === null ? "UNKNOWN" : gap >= PACE_TOLERANCE_POINTS ? "AHEAD" : gap <= -PACE_TOLERANCE_POINTS ? "BEHIND" : "ON_TRACK";
    return {
      key: w.key, label: w.label, from, to, availableNights: available, onBooksNights: bookedDates.size, occupancy, pickup, cancelled,
      lastYear: { from: lyFrom, to: lyTo, occupancy: lyOcc, onBooksNights: reason === null ? lyBooked.size : null },
      gapPoints: gap, status, unknownReason: reason,
    };
  });
}

export const PACE_STATUS_LABEL: Record<PaceStatus, string> = { AHEAD: "en avance", ON_TRACK: "dans la cible", BEHIND: "en retard", UNKNOWN: "inconnu" };
export const PACE_REASON_LABEL: Record<Exclude<PaceReason, null>, string> = {
  NO_HISTORY: "aucune réservation connue",
  HISTORY_TOO_SHORT: "l'historique lu ne remonte pas à un an",
  NO_AVAILABILITY: "aucune nuit disponible",
};
