/**
 * Préparation de la vérification SuperHote — NON BRANCHÉE.
 *
 * Objectif futur : comparer le prix publié estimé par NuitSignal au prix réellement publié via SuperHote,
 * pour signaler une majoration saisie qui serait fausse ou périmée.
 *
 * TODO(SuperHote) : le format de l'API SuperHote n'est PAS supposé ici. À valider sur un cas réel après branchement :
 *   - quel endpoint renvoie le prix publié d'une nuit, et pour quel canal ;
 *   - si ce prix est déjà majoré ou s'il s'agit du prix de base avant majoration ;
 *   - l'unité (euros ou centimes) et la devise.
 * Tant que ces points ne sont pas validés, aucune implémentation de `SuperhotePriceSource` n'existe.
 */
import type { ISODate } from "../dates";

/** Tolérance d'arrondi par défaut : 1 € (le prix estimé est arrondi à l'euro pour l'affichage). */
export const DEFAULT_TOLERANCE_CENTS = 100;

export type SuperhoteQuery = { propertyId: string; channelKey: string; date: ISODate };

/** À implémenter après branchement de l'API SuperHote. Renvoie le prix réel en centimes, ou null s'il est indisponible. */
export interface SuperhotePriceSource {
  fetchPublishedPriceCents(q: SuperhoteQuery): Promise<number | null>;
}

export type PriceCheck =
  | { status: "OK"; gapCents: number }
  | { status: "A_VERIFIER"; gapCents: number }
  | { status: "INCONNU"; gapCents: null };

/**
 * Compare le prix estimé et le prix réel. Écart (réel − estimé) dans la tolérance → « OK » ;
 * au-delà → « A_VERIFIER » (majoration à vérifier) ; l'un des deux prix inconnu → « INCONNU ».
 */
export function comparePublishedPrice(estimatedCents: number | null | undefined, actualCents: number | null | undefined, toleranceCents: number = DEFAULT_TOLERANCE_CENTS): PriceCheck {
  if (typeof estimatedCents !== "number" || typeof actualCents !== "number") return { status: "INCONNU", gapCents: null };
  const gapCents = Math.round((actualCents - estimatedCents) * 1e6) / 1e6;
  return Math.abs(gapCents) <= toleranceCents ? { status: "OK", gapCents } : { status: "A_VERIFIER", gapCents };
}
