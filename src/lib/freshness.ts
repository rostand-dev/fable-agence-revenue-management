/**
 * Fraîcheur des données (blueprint §7.4). Une opportunité financière exige par défaut : réservations < 24 h, disponibilité < 6 h, prix < 24 h,
 * marché < 48 h, promotions vérifiées < 7 jours. Au-delà, la confiance baisse ou l'exécution est bloquée (décidé par le moteur, pas ici).
 * Module pur : un seuil se change à un seul endroit.
 */
export type FreshnessKind = "RESERVATIONS" | "AVAILABILITY" | "PRICING" | "MARKET" | "PROMOTIONS";
export const MAX_AGE_HOURS: Record<FreshnessKind, number> = { RESERVATIONS: 24, AVAILABILITY: 6, PRICING: 24, MARKET: 48, PROMOTIONS: 168 };
export type Freshness = { state: "FRESH" | "STALE" | "MISSING"; ageHours: number | null; maxHours: number };

export function freshnessOf(kind: FreshnessKind, observedAt: Date | string | null | undefined, now: Date = new Date()): Freshness {
  const maxHours = MAX_AGE_HOURS[kind];
  const t = observedAt ? new Date(observedAt).getTime() : NaN;
  if (!Number.isFinite(t)) return { state: "MISSING", ageHours: null, maxHours };
  // une observation « dans le futur » (horloge décalée) est traitée comme toute neuve, jamais comme négative
  const ageHours = Math.max(0, (now.getTime() - t) / 3_600_000);
  return { state: ageHours < maxHours ? "FRESH" : "STALE", ageHours: Math.round(ageHours * 10) / 10, maxHours };
}
