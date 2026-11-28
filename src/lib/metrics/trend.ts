/**
 * Tendance d'un logement : mois en cours comparé au mois précédent, sur trois indicateurs
 * (revenu net, occupation, prix moyen net). Module pur (aucun accès base) ; la lecture est dans `services/trend.ts`.
 *
 * Règles :
 * - « stable » : variation relative de 5 % au plus, dans un sens ou dans l'autre (même seuil que la fiche du logement) ;
 * - le mois en cours porte les nuits réservées à ce jour sur le mois entier : l'écran doit le dire ;
 * - une donnée manquante ne vaut jamais zéro : la tendance est alors « inconnue », avec son motif ;
 * - réservations pas à jour (source reliée en échec ou lue il y a trop longtemps) : une absence ne prouve rien, tout est inconnu ;
 * - sans source reliée, un mois en cours sans aucune nuit vendue est inconnu (rien ne dit que la saisie est à jour) ;
 * - un vrai zéro (mois entièrement lu à une source à jour, aucune nuit vendue) reste un zéro.
 */
import { fmtMonth, type ISODate } from "../dates";
import { lastMonths } from "../engine/metrics";
import type { Kpi } from "./kpi";

/** Variation relative en deçà de laquelle (bornes comprises) un indicateur est dit stable. */
export const STABLE_THRESHOLD = 0.05;

export type TrendDirection = "UP" | "STABLE" | "DOWN" | "UNKNOWN";
export type Trend = { direction: TrendDirection; reason: string | null };
export type TrendKey = "revenue" | "occupancy" | "price";
export type MonthTrend = Record<TrendKey, Trend> & { month: string; previousMonth: string };
/** Le mois précédent est-il entièrement dans l'historique lu ? (mêmes valeurs que `Coverage` de services/performance) */
export type HistoryCoverage = "FULL" | "PARTIAL" | "BEFORE_HISTORY" | "NO_HISTORY";

/** D'où viennent les réservations : source reliée à jour (ou démonstration), source reliée pas à jour, ou aucune source. */
export type ReservationSource = "FRESH" | "STALE" | "UNLINKED";

export const TREND_KEYS: TrendKey[] = ["revenue", "occupancy", "price"];
export const TREND_NAME: Record<TrendKey, string> = { revenue: "Revenu", occupancy: "Occupation", price: "Prix moyen" };
export const TREND_ARROW: Record<TrendDirection, string> = { UP: "↗", STABLE: "→", DOWN: "↘", UNKNOWN: "?" };
/** « 2026-11 » → « novembre » */
export const monthName = (key: string) => fmtMonth(key).split(" ")[0];
/** Accord en genre : « Revenu inconnu », « Occupation inconnue ». */
export const trendLabel = (key: TrendKey, d: TrendDirection) =>
  d === "UP" ? "en hausse" : d === "DOWN" ? "en baisse" : d === "STABLE" ? "stable" : key === "occupancy" ? "inconnue" : "inconnu";

/** Les deux mois comparés : celui de `today`, puis le précédent. */
export function trendMonths(today: ISODate): { month: string; previousMonth: string } {
  const [previousMonth, month] = lastMonths(today, 2, true);
  return { month, previousMonth };
}

export function direction(current: number, previous: number): Exclude<TrendDirection, "UNKNOWN"> {
  if (previous === 0) return current === 0 ? "STABLE" : current > 0 ? "UP" : "DOWN";
  const change = (current - previous) / Math.abs(previous);
  // tolérance d'arrondi : 105 contre 100 est « stable », pas « en hausse » à cause de 0,050000000000000044
  return Math.abs(change) <= STABLE_THRESHOLD + 1e-9 ? "STABLE" : change > 0 ? "UP" : "DOWN";
}

const unknown = (reason: string): Trend => ({ direction: "UNKNOWN", reason });
const known = (current: number, previous: number): Trend => ({ direction: direction(current, previous), reason: null });

/** Pourquoi un mois ne dit rien : historique qui ne le couvre pas, source pas à jour, ou saisie sans aucune nuit. null : le mois est lisible. */
function unreadReason(coverage: HistoryCoverage, coveredMonth: string, current: Kpi, source: ReservationSource): string | null {
  const name = fmtMonth(coveredMonth);
  return coverage === "NO_HISTORY" ? "aucune réservation lue" : coverage === "PARTIAL" ? `historique incomplet en ${name}` : coverage === "BEFORE_HISTORY" ? `aucun historique en ${name}`
    : source === "STALE" ? "réservations pas à jour"
    : source === "UNLINKED" && current.soldNights === 0 ? `aucune réservation enregistrée en ${fmtMonth(current.period.from.slice(0, 7))}` : null;
}

/** Une commission inconnue sur une nuit vendue : le revenu net et le prix net ne sont pas calculables. */
const netIncomplete = (k: Kpi) => k.netStatus === "PARTIAL" || k.netStatus === "UNKNOWN";

/** `current` et `previous` : KPI des deux mois civils entiers ; `coverage` : couverture du mois précédent par l'historique. */
export function compareMonths(current: Kpi, previous: Kpi, coverage: HistoryCoverage, source: ReservationSource): MonthTrend {
  const month = current.period.from.slice(0, 7), previousMonth = previous.period.from.slice(0, 7);
  const unread = unreadReason(coverage, previousMonth, current, source);
  if (unread) {
    const t = unknown(unread);
    return { month, previousMonth, revenue: t, occupancy: t, price: t };
  }
  const netMissing = [current, previous].some(netIncomplete);
  const revenue = netMissing || current.netRoomCents === null || previous.netRoomCents === null
    ? unknown("commissions manquantes") : known(current.netRoomCents, previous.netRoomCents);
  const occupancy = current.occupancy === null || previous.occupancy === null
    ? unknown("aucune nuit disponible") : known(current.occupancy, previous.occupancy);
  const emptyMonth = current.soldNights === 0 ? month : previous.soldNights === 0 ? previousMonth : null;
  const price = netMissing ? unknown("commissions manquantes")
    : current.netAdrCents === null || previous.netAdrCents === null
      ? unknown(emptyMonth ? `aucune nuit vendue en ${fmtMonth(emptyMonth)}` : "prix non calculable")
      : known(current.netAdrCents, previous.netAdrCents);
  return { month, previousMonth, revenue, occupancy, price };
}

/** Une valeur du mois, ou le motif pour lequel elle est inconnue : jamais les deux, jamais un zéro par défaut. */
export type MonthValue = { value: number; reason: null } | { value: null; reason: string };
/** Valeurs du mois en cours : revenu net et prix moyen net en centimes, occupation de 0 à 1. */
export type MonthValues = Record<TrendKey, MonthValue>;

const missing = (reason: string): MonthValue => ({ value: null, reason });
const read = (value: number): MonthValue => ({ value, reason: null });

/** Valeurs du mois en cours (nuits réservées à ce jour) ; `coverage` : couverture de CE mois par l'historique. */
export function monthValues(current: Kpi, coverage: HistoryCoverage, source: ReservationSource): MonthValues {
  const month = current.period.from.slice(0, 7);
  const unread = unreadReason(coverage, month, current, source);
  if (unread) return { revenue: missing(unread), occupancy: missing(unread), price: missing(unread) };
  const noNet = netIncomplete(current);
  return {
    revenue: noNet || current.netRoomCents === null ? missing("commissions manquantes") : read(current.netRoomCents),
    occupancy: current.occupancy === null ? missing("aucune nuit disponible") : read(current.occupancy),
    price: noNet ? missing("commissions manquantes") : current.netAdrCents === null ? missing(`aucune nuit vendue en ${fmtMonth(month)}`) : read(current.netAdrCents),
  };
}
