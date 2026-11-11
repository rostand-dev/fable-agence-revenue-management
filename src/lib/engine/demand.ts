/**
 * Modèle de vente volontairement simple et transparent, utilisé pour comparer des options
 * entre elles. Ce n'est pas une prévision : chaque montant qui en découle est présenté
 * comme une simulation, avec son hypothèse. À calibrer sur les résultats mesurés.
 */
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

/**
 * Probabilité approchée de vendre une nuit libre, selon l'occupation du marché et la position de prix.
 * La sensibilité au prix croît avec le percentile : un logement cher par rapport à son marché gagne
 * davantage à baisser qu'un logement déjà bon marché.
 */
export function sellProbability(marketOccupancy: number, pricePercentile: number): number {
  return clamp(marketOccupancy * (1.3 - 0.6 * (pricePercentile / 100) ** 2), 0.03, 0.95);
}
/** Déplacement approché de la position de prix : 1 % de prix ≈ 2,4 points de percentile. */
export function percentileAfter(pricePercentile: number, priceChangePct: number): number {
  return clamp(pricePercentile + priceChangePct * 2.4, 2, 98);
}
export const DEMAND_MODEL_NOTE =
  "Probabilité de vente approchée par l'occupation du marché et la position de prix — modèle simple, non calibré sur ce logement.";
