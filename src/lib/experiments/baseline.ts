/**
 * Baseline d'une action (US-110, blueprint §17.4). Module pur, sans accès base.
 *
 * Elle fige, AVANT l'effet de l'action, ce qui permettra de dire plus tard si quelque chose a changé :
 * - l'état des séjours visés (nuits déjà réservées, bloquées, disponibles) ;
 * - le **rythme de réservation de référence** : nuits des séjours visés réservées pendant les `BASELINE_DAYS` jours précédents ;
 * - le **comparable historique** : la même chose un an plus tôt (52 semaines), s'il y a assez d'historique pour le dire.
 *
 * Règles (blueprint §3, principes 5 et 7) :
 * - une donnée absente n'est jamais un zéro : sans historique couvrant la fenêtre de référence, la baseline est **insuffisante**
 *   (`sufficient: false`, raison dite) et la mesure restera non concluante plutôt que de comparer à un faux zéro ;
 * - un net partiel (commission inconnue sur certaines nuits) ne se complète pas : `netCents` ne somme que les nuits connues, `netNights` dit lesquelles ;
 * - les annulations n'ont plus de nuits : elles ne figurent ni dans la référence ni dans la mesure (limite assumée, déjà dite pour le pacing).
 */
import { addDays, diffDays, type ISODate } from "../dates";
import { BASELINE_DAYS, baselineWindow, clipStay, COMPARABLE_OFFSET_DAYS, shiftWindow, windowDays, type DateWindow } from "./windows";

export type BookedNight = { night: ISODate; bookedAt: ISODate; channel: string; grossRoomCents: number; commissionCents: number | null; paymentFeeCents: number | null };

/** Nuits des séjours visés réservées pendant une fenêtre de réservation. */
export type PickupStats = {
  nights: number;
  /** Jours de réservation de la fenêtre (diviseur de `perDay`). */
  days: number;
  perDay: number;
  grossCents: number;
  /** Net des seules nuits dont la commission est connue ; null si aucune. */
  netCents: number | null;
  /** Nuits dont la commission est connue : `netNights === nights` = net complet. */
  netNights: number;
};

export type BaselineLimit = "STAY_PAST" | "NO_HISTORY" | "HISTORY_TOO_SHORT";
export const BASELINE_LIMIT_LABEL: Record<BaselineLimit, string> = {
  STAY_PAST: "toutes les nuits visées étaient déjà passées à l'entrée en vigueur",
  NO_HISTORY: "aucune réservation connue pour ce logement",
  HISTORY_TOO_SHORT: "l'historique lu ne remonte pas jusqu'à la fenêtre de référence",
};
export type ComparableReason = "NO_HISTORY" | "HISTORY_TOO_SHORT" | "STAY_PAST";
export const COMPARABLE_REASON_LABEL: Record<ComparableReason, string> = {
  NO_HISTORY: "aucune réservation connue",
  HISTORY_TOO_SHORT: "l'historique lu ne remonte pas à un an",
  STAY_PAST: "aucune nuit à comparer",
};

export type Baseline = {
  version: 1;
  /** Jour où la baseline a été figée. */
  asOf: ISODate;
  effectiveOn: ISODate;
  /** Nuits visées encore à vendre à l'entrée en vigueur ; null si toutes déjà passées. */
  stay: (DateWindow & { nights: number }) | null;
  /** Fenêtre de réservation de référence. */
  window: DateWindow & { days: number };
  /** État des séjours visés à la capture. */
  onBooks: { bookedNights: number; blockedNights: number; availableNights: number; occupancy: number | null } | null;
  pickup: PickupStats | null;
  /** Même fenêtre un an plus tôt : nuits réservées pendant la même fenêtre de réservation décalée. */
  comparable: { available: boolean; reason: ComparableReason | null; window: DateWindow | null; pickupNights: number | null; days: number };
  sufficient: boolean;
  limits: BaselineLimit[];
  /** Vrai si la baseline a été figée après l'entrée en vigueur (date déclarée dans le passé) : les nuits bloquées et les annulations sont lues à la capture, pas à l'entrée en vigueur. */
  capturedLate?: boolean;
};

export type BaselineInput = {
  asOf: ISODate;
  effectiveOn: ISODate;
  stayFrom: ISODate;
  stayTo: ISODate;
  /** Nuits vendues (confirmées) du logement, au moins celles des séjours visés et celles d'un an plus tôt. */
  nights: BookedNight[];
  /** Dates bloquées par le propriétaire (réservations de blocage et calendrier lu). */
  blocked: ISODate[];
  /** Plus ancienne réservation connue : sans elle, ou plus récente que la fenêtre de référence, la baseline est insuffisante. */
  firstBookingDate: ISODate | null;
  /** Première nuit de séjour connue (l'historique doit aussi couvrir les nuits comparées). */
  firstStayDate: ISODate | null;
};

const within = (d: ISODate, w: DateWindow) => d >= w.from && d < w.to;

/** Nuits des séjours `stay` réservées pendant `book` : rythme, brut et net (connu). Fonction partagée avec la mesure (US-111), pour comparer des choses comparables. */
export function pickupOf(nights: BookedNight[], stay: DateWindow, book: DateWindow): PickupStats {
  const rows = nights.filter((n) => within(n.night, stay) && within(n.bookedAt, book));
  const days = Math.max(1, windowDays(book));
  let gross = 0, net = 0, netNights = 0;
  for (const n of rows) {
    gross += n.grossRoomCents;
    if (n.commissionCents !== null) { net += n.grossRoomCents - n.commissionCents - (n.paymentFeeCents ?? 0); netNights += 1; }
  }
  return { nights: rows.length, days, perDay: rows.length / days, grossCents: gross, netCents: netNights ? net : null, netNights };
}

/** Un montant net moyen par nuit (centimes) ; null si aucune nuit au net connu. */
export const netPerNight = (p: PickupStats): number | null => (p.netCents !== null && p.netNights > 0 ? Math.round(p.netCents / p.netNights) : null);

export function computeBaseline(i: BaselineInput): Baseline {
  const window: DateWindow = baselineWindow(i.effectiveOn);
  const stay = clipStay(i.stayFrom, i.stayTo, i.effectiveOn);
  const limits: BaselineLimit[] = [];
  if (!stay) limits.push("STAY_PAST");
  if (i.firstBookingDate === null) limits.push("NO_HISTORY");
  else if (i.firstBookingDate > window.from) limits.push("HISTORY_TOO_SHORT");

  const base = { version: 1 as const, asOf: i.asOf, effectiveOn: i.effectiveOn, capturedLate: i.effectiveOn < i.asOf, window: { ...window, days: BASELINE_DAYS } };
  if (!stay) {
    return { ...base, stay: null, onBooks: null, pickup: null, comparable: { available: false, reason: "STAY_PAST", window: null, pickupNights: null, days: BASELINE_DAYS }, sufficient: false, limits };
  }
  const stayDays = diffDays(stay.to, stay.from);
  const booked = new Set(i.nights.filter((n) => within(n.night, stay) && n.bookedAt < i.effectiveOn).map((n) => n.night));
  const blockedOnly = new Set(i.blocked.filter((d) => within(d, stay) && !booked.has(d)));
  const available = stayDays - blockedOnly.size;
  const onBooks = { bookedNights: booked.size, blockedNights: blockedOnly.size, availableNights: available, occupancy: available > 0 ? booked.size / available : null };

  const pickup = pickupOf(i.nights, stay, window);

  const lyStay = shiftWindow(stay, -COMPARABLE_OFFSET_DAYS), lyWindow = shiftWindow(window, -COMPARABLE_OFFSET_DAYS);
  let reason: ComparableReason | null = null;
  if (i.firstBookingDate === null || i.firstStayDate === null) reason = "NO_HISTORY";
  else if (i.firstBookingDate > lyWindow.from || i.firstStayDate > lyStay.from) reason = "HISTORY_TOO_SHORT";
  const comparable = { available: reason === null, reason, window: lyWindow, pickupNights: reason === null ? pickupOf(i.nights, lyStay, lyWindow).nights : null, days: BASELINE_DAYS };

  return { ...base, stay: { ...stay, nights: stayDays }, onBooks, pickup, comparable, sufficient: limits.length === 0, limits };
}

/** Jour de comparaison d'un jour donné un an plus tôt (utile aux tests et à la mesure). */
export const lastYearOf = (d: ISODate): ISODate => addDays(d, -COMPARABLE_OFFSET_DAYS);
