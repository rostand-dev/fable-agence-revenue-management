/**
 * Résultat d'une expérience (US-111, blueprint §17.4). Module pur, sans accès base.
 *
 * On compare le rythme de réservation OBSERVÉ après l'action (nuits des séjours visés réservées pendant la fenêtre d'observation) à celui de la
 * référence figée avant l'action (US-110), au même nombre de jours près. Aucune période témoin n'existe : un résultat dit ce qui s'est passé APRÈS
 * l'action, jamais ce que l'action a causé. L'effet incrémental reste inconnu.
 *
 * Règles (jamais devinées) :
 * - **non concluant** : référence héritée ou insuffisante, séjours déjà passés, observation trop courte ou absente, réservations non synchronisées
 *   récemment (une absence de réservation ne prouve rien si la source est en retard), autre action mêlée (effets non séparables, blueprint §6.4) ;
 * - **positif** : au moins `MIN_DELTA_NIGHTS` nuits de plus que ce que la référence laissait attendre ET `MIN_RELATIVE_CHANGE` de plus ;
 * - **négatif** : l'inverse ; **neutre** sinon ;
 * - **dilution** : un gain de volume dont le net par nuit baisse de plus de `DILUTION_THRESHOLD` (net connu des deux côtés) n'est pas démontré en revenu : neutre.
 */
import { diffDays } from "../dates";
import { netPerNight, pickupOf, type Baseline, type BookedNight, type PickupStats } from "./baseline";
import type { DateWindow } from "./windows";

export type Outcome = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "INCONCLUSIVE";
export const OUTCOMES: readonly Outcome[] = ["POSITIVE", "NEUTRAL", "NEGATIVE", "INCONCLUSIVE"];
export const OUTCOME_LABEL: Record<Outcome, string> = { POSITIVE: "Positif", NEUTRAL: "Neutre", NEGATIVE: "Négatif", INCONCLUSIVE: "Non concluant" };
export const OUTCOME_ROLE: Record<Outcome, "sain" | "neutre" | "veto" | "attention"> = { POSITIVE: "sain", NEUTRAL: "neutre", NEGATIVE: "veto", INCONCLUSIVE: "attention" };

/** Observation de moins de 3 jours : trop court pour dire quoi que ce soit d'un rythme. */
export const MIN_OBSERVATION_DAYS = 3;
/** Écart minimal, en nuits, entre l'attendu et l'observé. */
export const MIN_DELTA_NIGHTS = 2;
/** Écart relatif minimal (25 %) entre l'attendu et l'observé. */
export const MIN_RELATIVE_CHANGE = 0.25;
/** Baisse du net par nuit (15 %) au-delà de laquelle un gain de volume est jugé dilué. */
export const DILUTION_THRESHOLD = 0.15;

export type OutcomeReason =
  | "LEGACY" | "BASELINE_INSUFFICIENT" | "STAY_PAST" | "NO_OBSERVATION_WINDOW" | "OBSERVATION_TOO_SHORT"
  | "RESERVATIONS_STALE" | "OVERLAPPING_ACTION" | "PRICE_DILUTION";
export const OUTCOME_REASON_LABEL: Record<OutcomeReason, string> = {
  LEGACY: "action antérieure au suivi des expériences : aucune référence n'avait été figée",
  BASELINE_INSUFFICIENT: "la référence figée avant l'action est insuffisante",
  STAY_PAST: "toutes les nuits visées étaient déjà passées à l'entrée en vigueur",
  NO_OBSERVATION_WINDOW: "aucune fenêtre d'observation n'a été fixée",
  OBSERVATION_TOO_SHORT: `l'observation dure moins de ${MIN_OBSERVATION_DAYS} jours`,
  RESERVATIONS_STALE: "les réservations n'étaient pas synchronisées récemment : une absence de réservation ne prouverait rien",
  OVERLAPPING_ACTION: "une autre action sur les mêmes séjours s'observait en même temps : leurs effets ne se séparent pas",
  PRICE_DILUTION: "les nuits supplémentaires se sont vendues moins cher : le gain de volume n'est pas démontré en revenu",
};

export type OutcomeInput = {
  /** Baseline figée (US-110), `null` pour une expérience héritée. */
  baseline: Baseline | null;
  observation: DateWindow | null;
  /** Nuits vendues du logement sur les séjours visés (avec leur date de réservation). */
  nights: BookedNight[];
  /** Vrai si la source des réservations est assez récente (toujours vrai en démonstration). */
  reservationsFresh: boolean;
  /** Autres expériences non annulées du même logement, sur les mêmes séjours, observées en même temps. */
  overlapping: number;
};

export type OutcomeResult = {
  outcome: Outcome;
  reasons: OutcomeReason[];
  /** Rythme observé (null si non mesurable). */
  observed: PickupStats | null;
  /** Nuits que la référence laissait attendre sur la durée d'observation. */
  expectedNights: number | null;
  deltaNights: number | null;
  /** Écart relatif : delta / max(attendu, 1). */
  relativeChange: number | null;
  baseNetPerNight: number | null;
  observedNetPerNight: number | null;
  observationDays: number | null;
  /** Ce qui a été observé, en français. */
  summary: string;
  /** Ce que l'on peut en dire, et ce que l'on ne peut pas. */
  interpretation: string;
  confidence: "faible";
};

const fr = (x: number) => x.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const nuits = (n: number) => `${n} nuit${n > 1 ? "s" : ""}`;
const NO_CAUSE = "Sans période témoin, ce résultat décrit ce qui s'est passé après l'action ; il ne prouve pas qu'elle en soit la cause.";

export function classifyOutcome(i: OutcomeInput): OutcomeResult {
  const reasons: OutcomeReason[] = [];
  const b = i.baseline;
  if (!b) reasons.push("LEGACY");
  else {
    if (!b.sufficient) reasons.push("BASELINE_INSUFFICIENT");
    if (!b.stay) reasons.push("STAY_PAST");
  }
  const obsDays = i.observation ? diffDays(i.observation.to, i.observation.from) : null;
  if (!i.observation || obsDays === null || obsDays <= 0) reasons.push("NO_OBSERVATION_WINDOW");
  else if (obsDays < MIN_OBSERVATION_DAYS) reasons.push("OBSERVATION_TOO_SHORT");
  if (!i.reservationsFresh) reasons.push("RESERVATIONS_STALE");
  if (i.overlapping > 0) reasons.push("OVERLAPPING_ACTION");

  const empty = (summary: string): OutcomeResult => ({
    outcome: "INCONCLUSIVE", reasons, observed: null, expectedNights: null, deltaNights: null, relativeChange: null, baseNetPerNight: null, observedNetPerNight: null, observationDays: obsDays,
    summary, interpretation: `Non concluant : ${reasons.map((r) => OUTCOME_REASON_LABEL[r]).join(" ; ")}. Rien n'est supposé à la place.`, confidence: "faible",
  });
  // sans référence ou sans fenêtre exploitable : rien à comparer
  if (!b || !b.pickup || !b.stay || !i.observation || obsDays === null || obsDays <= 0) return empty(!b ? "Référence avant action inconnue." : "Aucune comparaison possible : référence ou fenêtre d'observation manquante.");

  const observed = pickupOf(i.nights, { from: b.stay.from, to: b.stay.to }, i.observation);
  const expected = b.pickup.perDay * obsDays;
  const delta = observed.nights - expected;
  const relative = delta / Math.max(expected, 1);
  const baseNet = netPerNight(b.pickup), obsNet = netPerNight(observed);
  const summary = `${nuits(observed.nights)} réservée${observed.nights > 1 ? "s" : ""} en ${obsDays} jour${obsDays > 1 ? "s" : ""} (${fr(observed.perDay)} par jour) sur les séjours visés, contre ${fr(expected)} attendue${expected >= 2 ? "s" : ""} d'après les ${b.window.days} jours précédant l'action (${fr(b.pickup.perDay)} par jour).`;
  const base: Omit<OutcomeResult, "outcome" | "interpretation"> = { reasons, observed, expectedNights: expected, deltaNights: delta, relativeChange: relative, baseNetPerNight: baseNet, observedNetPerNight: obsNet, observationDays: obsDays, summary, confidence: "faible" };

  // une donnée qui rend la lecture non fiable l'emporte sur tout chiffre : on dit pourquoi, on ne conclut pas
  const blocking = reasons.filter((r) => r !== "PRICE_DILUTION");
  if (blocking.length) return { ...base, outcome: "INCONCLUSIVE", interpretation: `Non concluant : ${blocking.map((r) => OUTCOME_REASON_LABEL[r]).join(" ; ")}. Le rythme observé est donné à titre indicatif seulement.` };

  let outcome: Outcome = delta >= MIN_DELTA_NIGHTS && relative >= MIN_RELATIVE_CHANGE ? "POSITIVE" : delta <= -MIN_DELTA_NIGHTS && relative <= -MIN_RELATIVE_CHANGE ? "NEGATIVE" : "NEUTRAL";
  if (outcome === "POSITIVE" && baseNet !== null && obsNet !== null && obsNet < baseNet * (1 - DILUTION_THRESHOLD)) { outcome = "NEUTRAL"; reasons.push("PRICE_DILUTION"); }
  const interpretation = outcome === "POSITIVE" ? `Le rythme de réservation s'est accéléré après l'action. ${NO_CAUSE}`
    : outcome === "NEGATIVE" ? `Le rythme de réservation a ralenti après l'action. ${NO_CAUSE}`
    : reasons.includes("PRICE_DILUTION") ? `Plus de nuits se sont vendues, mais à un net par nuit plus bas de plus de ${Math.round(DILUTION_THRESHOLD * 100)} % (${obsNet !== null ? fr(obsNet / 100) : "?"} € contre ${baseNet !== null ? fr(baseNet / 100) : "?"} €) : le gain en volume n'est pas démontré en revenu. ${NO_CAUSE}`
    : `Pas d'écart net avec le rythme d'avant l'action (il faut au moins ${MIN_DELTA_NIGHTS} nuits et ${Math.round(MIN_RELATIVE_CHANGE * 100)} % d'écart). ${NO_CAUSE}`;
  return { ...base, reasons, outcome, interpretation };
}
