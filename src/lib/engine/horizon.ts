import { addDays } from "../dates";
import type { Day } from "./types";

export type HorizonSummary = {
  nights: number;
  booked: number; blocked: number; free: number;
  /** Nuits vendables = réservées + libres (les nuits bloquées sont hors vente). null si aucune. */
  sellable: number;
  /** Part des nuits vendables déjà réservées ; null si aucune nuit vendable (jamais 0 par défaut). */
  occupancy: number | null;
  /** Nuits (hors bloquées) couvertes par un dossier ouvert, dont celles couvertes par un veto. */
  flagged: number; vetoed: number;
  /** Nuits libres dont le prix n'est pas connu : comptées à part, jamais comme un prix nul. */
  freeUnpriced: number;
};

/** Synthèse de l'horizon D+90. `flagged` : date → true si un veto couvre la nuit, false si un dossier ouvert sans veto. */
export function horizonSummary(days: Pick<Day, "date" | "state" | "priceCents">[], flagged: Map<string, boolean>): HorizonSummary {
  let booked = 0, blocked = 0, free = 0, fl = 0, veto = 0, unpriced = 0;
  for (const d of days) {
    if (d.state === "BOOKED") booked++; else if (d.state === "BLOCKED") { blocked++; continue; } else { free++; if (d.priceCents === null || d.priceCents === undefined) unpriced++; }
    const f = flagged.get(d.date);
    if (f !== undefined) { fl++; if (f) veto++; }
  }
  const sellable = booked + free;
  return { nights: days.length, booked, blocked, free, sellable, occupancy: sellable ? booked / sellable : null, flagged: fl, vetoed: veto, freeUnpriced: unpriced };
}

/** Playbooks dont la période n'est pas une affaire de nuits à vendre : ils ne colorent pas le calendrier. */
const NOT_ON_CALENDAR = new Set(["PB-10", "PB-13"]);
export const coversNights = (playbook: string) => !NOT_ON_CALENDAR.has(playbook);

/** Nuits couvertes par un dossier ouvert : date → true si un veto la couvre, false si un dossier sans veto. */
export function flaggedNights(opps: { playbook: string; stayFrom: string; stayTo: string; veto: boolean }[]): Map<string, boolean> {
  const flagged = new Map<string, boolean>();
  for (const o of opps.filter((x) => coversNights(x.playbook))) for (let d = o.stayFrom; d < o.stayTo; d = addDays(d, 1)) flagged.set(d, flagged.get(d) || o.veto);
  return flagged;
}
