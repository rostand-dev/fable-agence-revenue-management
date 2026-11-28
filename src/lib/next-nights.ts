/**
 * Fiche de poche : les quatorze prochaines nuits (état, prix, situation ouverte) et les situations qui couvrent des nuits libres.
 * Module pur (aucun accès base). Mêmes règles que le calendrier à 90 jours pour le prix et pour les dossiers signalés.
 */
import { addDays, fmtDay, type ISODate } from "./dates";
import { coversNights, flaggedNights } from "./engine/horizon";
import type { Day } from "./engine/types";
import { shownPriceCents, type ChannelMarkup } from "./pricing/published";

export const NEXT_NIGHTS = 14;
/** Nombre de situations listées sous la grille ; au-delà, un lien mène à toutes les situations du logement. */
export const NEXT_LINKS = 3;

export type NightState = Day["state"] | "UNKNOWN";
export type NextNight = {
  date: ISODate;
  /** UNKNOWN : nuit absente du calendrier lu. */
  state: NightState;
  /** Prix d'une nuit libre ; null : inconnu, ou sans objet (réservée, bloquée). */
  priceCents: number | null;
  /** Dossier ouvert sur une nuit libre (veto prioritaire). */
  flag: "veto" | "open" | null;
};
type Opp = { code: string; title: string; playbook: string; stayFrom: ISODate; stayTo: ISODate; veto: boolean; priority: number };
export type NextSituation = { code: string; title: string; veto: boolean; nights: ISODate[] };

/** Nuits à partir de `today`. `situations` : dossiers ouverts couvrant au moins une nuit libre de la fenêtre, vetos d'abord, puis par priorité. */
export function nextNights(days: Pick<Day, "date" | "state" | "priceCents" | "recommendedPriceCents">[], opps: Opp[], channel: ChannelMarkup | null, today: ISODate): { nights: NextNight[]; situations: NextSituation[] } {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const flagged = flaggedNights(opps);
  const nights: NextNight[] = Array.from({ length: NEXT_NIGHTS }, (_, i) => {
    const date = addDays(today, i), d = byDate.get(date);
    if (!d) return { date, state: "UNKNOWN", priceCents: null, flag: null };
    const free = d.state === "FREE", f = free ? flagged.get(date) : undefined;
    return { date, state: d.state, priceCents: free ? shownPriceCents(d, channel) : null, flag: f === undefined ? null : f ? "veto" : "open" };
  });
  const free = nights.filter((n) => n.state === "FREE").map((n) => n.date);
  const situations = opps.filter((o) => coversNights(o.playbook))
    .map((o) => ({ o, nights: free.filter((d) => d >= o.stayFrom && d < o.stayTo) }))
    .filter((x) => x.nights.length > 0)
    .sort((a, b) => Number(b.o.veto) - Number(a.o.veto) || b.o.priority - a.o.priority || a.nights[0].localeCompare(b.nights[0]) || a.o.code.localeCompare(b.o.code))
    .map(({ o, nights: n }) => ({ code: o.code, title: o.title, veto: o.veto, nights: n }));
  return { nights, situations };
}

/** « 6 déc. » → le mois, pour ne l'écrire qu'une fois quand deux dates le partagent. */
const shortDay = (d: ISODate, next?: ISODate) => (next && next.slice(0, 7) === d.slice(0, 7) ? String(Number(d.slice(8))) : fmtDay(d));

/** Des nuits libres (dates croissantes, au moins une) en une courte phrase : « Libres les 6 et 7 déc. ». */
export function freeNightsPhrase(dates: ISODate[]): string {
  const n = dates.length, first = dates[0], last = dates[n - 1];
  if (n === 1) return `Libre le ${fmtDay(first)}`;
  const run = dates.every((d, i) => i === 0 || d === addDays(dates[i - 1], 1));
  if (run && n > 2) return `Libres du ${shortDay(first, last)} au ${fmtDay(last)}`;
  if (n > 4) return `${n} nuits libres entre le ${shortDay(first, last)} et le ${fmtDay(last)}`;
  const parts = dates.map((d, i) => shortDay(d, dates[i + 1]));
  return `Libres les ${parts.slice(0, -1).join(", ")} et ${parts[n - 1]}`;
}
