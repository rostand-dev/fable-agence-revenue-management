import { addDays, type ISODate } from "../dates";
import type { PlMarketDay } from "./pricelabs-map";

/**
 * Import du marché / compset selon les capacités réelles du compte (US-042). Module pur.
 * Le marché est utile mais jamais bloquant : ce module dit ce que PriceLabs a réellement fourni (capacité), avec ses limites,
 * pour que les signaux de rythme restent « inconnus » quand ils ne peuvent pas être calculés, au lieu d'être supposés.
 *
 *  - AVAILABLE   : catégorie trouvée, compset suffisant, couverture suffisante.
 *  - LIMITED     : données présentes mais minces (compset réduit, jours sans occupation ou sans prix de marché).
 *  - NONE        : PriceLabs répond sans données de marché exploitables pour cette annonce (ou sans catégorie).
 *  - UNAVAILABLE : la lecture du marché a échoué (droits, quota, panne) ; les données précédentes sont conservées, datées.
 */
export type MarketCapability = "AVAILABLE" | "LIMITED" | "NONE" | "UNAVAILABLE";
/** Taille minimale d'un compset pour que les écarts de marché soient jugés fiables. */
export const MIN_COMPSET = 10;
/** Part minimale de jours avec occupation de marché pour parler de couverture suffisante. */
export const MIN_COVERAGE = 0.8;

export type MarketIssue = { code: "READ_FAILED" | "NO_DATA" | "NO_CATEGORY" | "SMALL_COMPSET" | "UNKNOWN_COMPSET" | "LOW_OCCUPANCY_COVERAGE" | "NO_PRICE_BENCHMARK"; severity: "WARN" | "INFO"; message: string };
export type MarketReport = {
  capability: MarketCapability;
  category: string | null; listingsUsed: number | null; source: string | null;
  expected: number; withOccupancy: number; withPrice: number; coverage: number;
  /** Jours de marché des lectures précédentes conservés faute de nouvelle lecture (UNAVAILABLE seulement). */
  keptDays: number;
  issues: MarketIssue[];
};

export function analyzeMarket(
  input: { market: PlMarketDay[]; category: string | null; listingsUsed: number | null; source: string | null; hasData: boolean },
  range: { from: ISODate; to: ISODate },
  readError: string | null,
  keptDays = 0,
): MarketReport {
  let expected = 0;
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) expected++;
  const inRange = input.market.filter((m) => m.date >= range.from && m.date <= range.to);
  const withOccupancy = inRange.filter((m) => m.marketOccupancy !== null).length;
  const withPrice = inRange.filter((m) => m.marketAdrCents !== null).length;
  const rawCoverage = expected ? withOccupancy / expected : 0, coverage = Math.round(rawCoverage * 100) / 100; // l'arrondi sert à l'affichage, jamais au seuil
  const base = { category: input.category, listingsUsed: input.listingsUsed, source: input.source, expected, withOccupancy, withPrice, coverage, keptDays };
  if (readError) return { ...base, capability: "UNAVAILABLE", withOccupancy: 0, withPrice: 0, coverage: 0, category: null, listingsUsed: null, source: null,
    issues: [{ code: "READ_FAILED", severity: "WARN", message: `${readError} ${keptDays ? `Les ${keptDays} jours de marché de la lecture précédente sont conservés, avec leur date.` : "Aucune lecture de marché précédente."}` }] };
  if (!input.hasData) return { ...base, capability: "NONE", issues: [{ code: "NO_DATA", severity: "WARN", message: "PriceLabs ne renvoie pas de données de marché pour cette annonce : les signaux de marché restent inconnus." }] };
  if (!input.category) return { ...base, capability: "NONE", issues: [{ code: "NO_CATEGORY", severity: "WARN", message: "Données de marché reçues sans catégorie exploitable (nombre de chambres) : aucun jour de marché n'est retenu." }] };
  const issues: MarketIssue[] = [];
  if (input.listingsUsed === null) issues.push({ code: "UNKNOWN_COMPSET", severity: "INFO", message: "PriceLabs n'indique pas la taille du compset : sa fiabilité est inconnue." });
  else if (input.listingsUsed < MIN_COMPSET) issues.push({ code: "SMALL_COMPSET", severity: "WARN", message: `Compset de ${input.listingsUsed} annonce${input.listingsUsed > 1 ? "s" : ""} seulement (moins de ${MIN_COMPSET}) : les écarts de marché sont peu fiables.` });
  if (rawCoverage < MIN_COVERAGE) issues.push({ code: "LOW_OCCUPANCY_COVERAGE", severity: "WARN", message: `Occupation de marché connue pour ${withOccupancy} jour${withOccupancy > 1 ? "s" : ""} sur ${expected} : les autres restent inconnus.` });
  if (withPrice === 0) issues.push({ code: "NO_PRICE_BENCHMARK", severity: "WARN", message: "Aucun prix de marché (centiles, prix médian réservé) : l'écart de prix au marché ne peut pas être calculé." });
  return { ...base, capability: issues.some((i) => i.severity === "WARN") ? "LIMITED" : "AVAILABLE", issues };
}
