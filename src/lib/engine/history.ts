/**
 * Historique de réservations lu par les playbooks de la famille « demande » (PB-08, PB-09, PB-11, PB-12) : annulations récentes, rythme de prise de
 * réservations, durée de séjour et mix de canaux, toujours en comparant une fenêtre récente à une fenêtre de référence de même longueur.
 * Module pur. Principe : une donnée absente reste inconnue (`null`), jamais un zéro. Les annulations ne sont connues que depuis le début de
 * l'historique SuperHote (`CancellationTracking.since`) : une fenêtre qui commence avant ce jour n'est pas évaluable.
 */
import { addDays, diffDays, type ISODate } from "../dates";
import type { Resa } from "./types";

/** Profondeur chargée par `loadEngineInput` : une fenêtre plus longue n'est pas évaluable (réponse « inconnu », jamais une réponse partielle). */
export const MAX_HISTORY_DAYS = 120;
export type Cancellation = { channel: string; checkIn: ISODate; checkOut: ISODate; nights: number; grossRoomCents: number; cancelledAt: ISODate };
/** Début de l'historique des annulations de ce logement (premier changement de réservation enregistré). */
export type CancellationTracking = { since: ISODate };

const inWin = (d: ISODate, from: ISODate, to: ISODate) => d >= from && d < to; // [from, to[
const confirmed = (resas: Resa[]) => resas.filter((r) => r.status === "CONFIRMED");

export type CancellationStats = {
  windowDays: number; from: ISODate; to: ISODate;
  /** réservations annulées dans la fenêtre (jour d'annulation) */
  cancelled: number; cancelledNights: number;
  /** réservations confirmées prises (jour de réservation) dans la fenêtre, annulations déjà retirées de ce compte */
  booked: number;
  /** annulées ÷ (annulées + prises) : part des réservations de la fenêtre qui ont été annulées ; null si aucune réservation ni annulation */
  rate: number | null;
  /** annulations par canal */
  byChannel: Record<string, number>;
  /** nuits annulées dont l'arrivée est encore à venir : ce sont des dates rouvertes à la vente */
  reopenedNights: number;
};

/**
 * Annulations de la fenêtre [today − windowDays + 1, today + 1[. Renvoie null quand elles ne sont pas évaluables : historique absent
 * (`tracking` null/undefined, logement jamais relu depuis SuperHote) ou commençant après le début de la fenêtre.
 */
export function cancellationStats(cancellations: Cancellation[] | undefined, tracking: CancellationTracking | null | undefined, resas: Resa[], today: ISODate, windowDays: number): CancellationStats | null {
  if (!cancellations || !tracking) return null;
  const from = addDays(today, -windowDays + 1), to = addDays(today, 1);
  // `since` est le jour du premier changement enregistré, dont le début de journée est peut-être manqué : la fenêtre doit commencer strictement après
  if (windowDays > MAX_HISTORY_DAYS || tracking.since >= from) return null;
  const inW = cancellations.filter((c) => inWin(c.cancelledAt, from, to));
  const booked = confirmed(resas).filter((r) => inWin(r.bookedAt, from, to)).length;
  const byChannel: Record<string, number> = {};
  for (const c of inW) byChannel[c.channel] = (byChannel[c.channel] ?? 0) + 1;
  const reopenedNights = inW.reduce((n, c) => { let k = 0; for (let i = 0; i < c.nights; i++) if (addDays(c.checkIn, i) >= today) k++; return n + k; }, 0);
  const total = inW.length + booked;
  return { windowDays, from, to, cancelled: inW.length, cancelledNights: inW.reduce((n, c) => n + c.nights, 0), booked, rate: total > 0 ? inW.length / total : null, byChannel, reopenedNights };
}

export type PeriodStat = { bookings: number; nights: number; medianLos: number | null; /** délai médian entre la réservation et l'arrivée, en jours ; null sous 3 réservations */ medianLead: number | null; /** réservations au délai valide (arrivée non antérieure à la réservation) */ leadSample: number; channelShare: Record<string, number> };
export type PaceComparison = {
  recentDays: number; refDays: number;
  recent: PeriodStat; reference: PeriodStat;
  /** prises récentes ÷ prises de référence, ramenées à la même longueur ; null si la référence est vide */
  bookingRatio: number | null;
  /** écart de délai médian de réservation (récent − référence), en jours ; null si un des deux échantillons est trop petit */
  leadShift: number | null;
  /** délai récent ÷ délai de référence − 1 (0,5 = 50 % plus anticipé) ; null si inconnu ou référence nulle */
  leadGrowth: number | null;
  /** écart de durée médiane de séjour (récent − référence), en nuits ; null si un des deux échantillons est trop petit */
  losShift: number | null;
  /** plus grand déplacement de part de nuits entre les deux périodes, avec son canal (points de part, 0..1) ; null si un échantillon est vide */
  channelShift: { channel: string; delta: number } | null;
};

const MIN_LOS_SAMPLE = 3;
function period(rs: Resa[]): PeriodStat {
  const nights = rs.reduce((n, r) => n + r.nights, 0);
  const los = rs.map((r) => r.nights).sort((a, b) => a - b);
  const share: Record<string, number> = {};
  for (const r of rs) share[r.channel] = (share[r.channel] ?? 0) + r.nights;
  for (const k of Object.keys(share)) share[k] /= nights || 1;
  const lead = rs.map((r) => diffDays(r.checkIn, r.bookedAt)).filter((x) => x >= 0).sort((a, b) => a - b);
  return { bookings: rs.length, nights, medianLos: los.length >= MIN_LOS_SAMPLE ? los[Math.floor(los.length / 2)] : null, medianLead: lead.length >= MIN_LOS_SAMPLE ? lead[Math.floor(lead.length / 2)] : null, leadSample: lead.length, channelShare: share };
}

/**
 * Rythme de prise de réservations : fenêtre récente (les `recentDays` derniers jours, aujourd'hui inclus) contre fenêtre de référence
 * (les `refDays` jours qui précèdent), selon le jour de réservation. Calculable dès que la première réservation connue précède la référence ; sinon null.
 * `firstBookingDate` : première réservation confirmée encore connue du logement. Elle ne prouve pas que la référence est réellement vide (un logement peut
 * n'avoir rien vendu depuis) : une référence à zéro donne un rapport inconnu, jamais un rythme « infini ». Durée et délai médians : médiane haute (entière) ; le délai écarte les dates incohérentes et `leadSample` compte ce qui reste. Les réservations annulées sont exclues des deux fenêtres (les longs délais s'annulant davantage, la référence peut être biaisée vers des délais courts).
 */
export function paceComparison(resas: Resa[], today: ISODate, recentDays: number, refDays: number, firstBookingDate: ISODate | null): PaceComparison | null {
  const rFrom = addDays(today, -recentDays + 1), rTo = addDays(today, 1), pFrom = addDays(rFrom, -refDays), pTo = rFrom;
  if (!firstBookingDate || firstBookingDate > pFrom) return null;
  const ok = confirmed(resas);
  const recent = period(ok.filter((r) => inWin(r.bookedAt, rFrom, rTo)));
  const reference = period(ok.filter((r) => inWin(r.bookedAt, pFrom, pTo)));
  const scale = recentDays / refDays;
  let channelShift: PaceComparison["channelShift"] = null;
  if (recent.nights > 0 && reference.nights > 0) {
    for (const ch of new Set([...Object.keys(recent.channelShare), ...Object.keys(reference.channelShare)])) {
      const d = (recent.channelShare[ch] ?? 0) - (reference.channelShare[ch] ?? 0);
      if (!channelShift || Math.abs(d) > Math.abs(channelShift.delta)) channelShift = { channel: ch, delta: d };
    }
  }
  return {
    recentDays, refDays, recent, reference,
    bookingRatio: reference.bookings > 0 ? recent.bookings / (reference.bookings * scale) : null,
    leadShift: recent.medianLead !== null && reference.medianLead !== null ? recent.medianLead - reference.medianLead : null,
    leadGrowth: recent.medianLead !== null && reference.medianLead !== null && reference.medianLead > 0 ? recent.medianLead / reference.medianLead - 1 : null,
    losShift: recent.medianLos !== null && reference.medianLos !== null ? recent.medianLos - reference.medianLos : null,
    channelShift,
  };
}

/** Observation datée de l'écart d'occupation au marché d'une fenêtre (une ligne de `market_gap_history`). `gap` null = marché inconnu ce jour-là. */
export type GapObservation = { day: ISODate; windowKey: string; gap: number | null };

/**
 * Début du retard en cours, lu sur l'historique daté : un jour est « en retard » si une fenêtre (hors J+0 à J+7, comme PB-01) a un écart ≤ `gapThreshold`,
 * « normal » si des écarts sont connus et aucun ne passe le seuil, « inconnu » si aucun écart n'est connu (le jour est ignoré : inconnu ≠ zéro).
 * On remonte depuis le dernier jour connu, qui doit être en retard et dater d'au plus `toleranceDays` ; un jour normal coupe la série ; deux jours en retard
 * séparés de plus de `toleranceDays` aussi (collecte interrompue). Une série n'est retenue que si elle compte au moins `minLagDays` jours en retard observés :
 * deux relevés isolés ne font pas un retard qui dure.
 * `resolved` = le dernier jour connu (récent, dans la tolérance) est normal : le retard est résolu, aucune autre preuve plus ancienne ne doit le prolonger.
 */
export function lagRunStart(obs: GapObservation[], today: ISODate, gapThreshold: number, toleranceDays: number, minLagDays = 1): { start: ISODate | null; resolved: boolean } {
  const byDay = new Map<ISODate, "LAG" | "OK">();
  for (const o of obs) {
    if (o.windowKey === "D0_7" || o.gap === null) continue;
    if (o.gap <= gapThreshold) byDay.set(o.day, "LAG");
    else if (!byDay.has(o.day)) byDay.set(o.day, "OK");
  }
  const days = [...byDay.keys()].sort().reverse();
  if (days.length === 0 || diffDays(today, days[0]) > toleranceDays) return { start: null, resolved: false };
  if (byDay.get(days[0]) !== "LAG") return { start: null, resolved: true };
  let start = days[0], lagDays = 1;
  for (const d of days.slice(1)) {
    if (byDay.get(d) === "OK") break;
    if (diffDays(start, d) > toleranceDays) break;
    start = d; lagDays++;
  }
  return { start: lagDays >= minLagDays ? start : null, resolved: false };
}
