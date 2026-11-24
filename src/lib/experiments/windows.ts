/**
 * Fenêtres de mesure d'une action (US-110, blueprint §17.4 : « baseline pré-action, courbe historique comparable, fenêtre d'observation »).
 * Module pur, sans accès base : l'écran, le service et les tests s'appuient sur les mêmes dates.
 *
 * Trois fenêtres, toutes en jours civils (Europe/Paris), bornes `from` inclus et `to` exclu :
 * - **séjours visés** : les nuits du dossier, ramenées aux nuits encore à venir le jour de l'entrée en vigueur (une nuit déjà passée ne peut plus être vendue,
 *   donc ne peut ni servir de référence ni mesurer un effet) ;
 * - **référence** (baseline) : les `BASELINE_DAYS` jours qui précèdent l'entrée en vigueur ;
 * - **observation** : de l'entrée en vigueur au jour de la mesure (exclu), fixée à la vérification de l'action.
 */
import { addDays, diffDays, todayISO, type ISODate } from "../dates";

/** Jours de réservation observés avant l'action pour établir le rythme de référence. */
export const BASELINE_DAYS = 14;
/** Décalage de la comparaison à l'an passé : 52 semaines, pour garder les jours de semaine (même règle que le pacing, US-051). */
export const COMPARABLE_OFFSET_DAYS = 364;

export type DateWindow = { from: ISODate; to: ISODate };

/** Nombre de jours d'une fenêtre. */
export const windowDays = (w: DateWindow): number => diffDays(w.to, w.from);

/** Fenêtre décalée (pour la même période un an plus tôt). */
export const shiftWindow = (w: DateWindow, days: number): DateWindow => ({ from: addDays(w.from, days), to: addDays(w.to, days) });

/** Nuits du dossier encore à vendre le jour de l'entrée en vigueur ; null si toutes sont déjà passées (ou fenêtre vide). */
export function clipStay(stayFrom: ISODate, stayTo: ISODate, effectiveOn: ISODate): DateWindow | null {
  const from = stayFrom < effectiveOn ? effectiveOn : stayFrom;
  return from < stayTo ? { from, to: stayTo } : null;
}

/** Fenêtre de référence : les `BASELINE_DAYS` jours précédant l'entrée en vigueur. */
export function baselineWindow(effectiveOn: ISODate): DateWindow {
  return { from: addDays(effectiveOn, -BASELINE_DAYS), to: effectiveOn };
}

/** Fenêtre d'observation : de l'entrée en vigueur au jour de la mesure (exclu). Null tant que la mesure n'est pas planifiée ou si elle ne laisse aucun jour. */
export function observationWindow(effectiveOn: ISODate, measureDueAt: ISODate | null | undefined): DateWindow | null {
  if (!measureDueAt || measureDueAt <= effectiveOn) return null;
  return { from: effectiveOn, to: measureDueAt };
}

/**
 * Jour d'entrée en vigueur de l'action : la date déclarée par l'opérateur pour une procédure manuelle (jamais dans le futur, validée à la confirmation),
 * sinon le jour de l'exécution. Une date déclarée absente ou mal formée retombe sur le jour de l'exécution.
 */
export function effectiveDateOf(declaredDate: unknown, executedAt: Date): ISODate {
  const today = todayISO(executedAt);
  if (typeof declaredDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(declaredDate) && declaredDate <= today) return declaredDate;
  return today;
}
