import { addDays, type ISODate } from "../dates";
import type { PlDay, PlListing } from "./pricelabs-map";

/**
 * Import de la configuration PriceLabs et contrôle de la grille de prix futurs (US-041). Modules purs, sans accès réseau ni base.
 * La configuration est ce que PriceLabs applique à l'annonce (prix de base, minimum, maximum, synchronisation) : elle est conservée en snapshot,
 * et chaque changement est comparé à la lecture précédente. La grille est contrôlée jour par jour : un trou ou un prix aberrant ne passe pas inaperçu.
 */
export type PricingConfiguration = {
  listingId: string; pms: string; currency: string | null;
  basePriceCents: number | null; minPriceCents: number | null; maxPriceCents: number | null;
  pushEnabled: boolean | null;
};
export function normalizeConfig(l: PlListing): PricingConfiguration {
  return { listingId: l.id, pms: l.pms, currency: l.currency, basePriceCents: l.baseCents, minPriceCents: l.minCents, maxPriceCents: l.maxCents, pushEnabled: l.pushEnabled };
}

export type ConfigChange = { key: keyof PricingConfiguration; label: string; from: string | null; to: string | null };
const LABELS: Record<keyof PricingConfiguration, string> = { listingId: "Annonce", pms: "PMS", currency: "Devise", basePriceCents: "Prix de base", minPriceCents: "Prix minimum", maxPriceCents: "Prix maximum", pushEnabled: "Synchronisation des prix" };
const show = (k: keyof PricingConfiguration, v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (k.endsWith("Cents")) return `${(Number(v) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} €`;
  if (k === "pushEnabled") return v ? "active" : "désactivée";
  return String(v);
};
/** Différences entre deux configurations, en clair. `prev` absent = première lecture : rien à comparer. */
export function diffConfig(prev: PricingConfiguration | null | undefined, cur: PricingConfiguration): ConfigChange[] {
  // une autre annonce que celle de la lecture précédente (rattachement changé) n'est pas un changement de configuration chez PriceLabs
  if (!prev || prev.listingId !== cur.listingId || prev.pms !== cur.pms) return [];
  return (Object.keys(LABELS) as (keyof PricingConfiguration)[])
    .filter((k) => (prev[k] ?? null) !== (cur[k] ?? null))
    .map((k) => ({ key: k, label: LABELS[k], from: show(k, prev[k]), to: show(k, cur[k]) }));
}

export type GridIssue = { code: "MISSING_DAYS" | "UNKNOWN_PRICES" | "BELOW_MIN" | "ABOVE_MAX" | "MIN_ABOVE_MAX" | "MIN_ABOVE_BASE" | "BASE_OUTSIDE_BOUNDS" | "NO_BOUNDS"; severity: "WARN" | "INFO"; message: string; dates?: ISODate[]; /** nombre total de dates concernées (`dates` en garde 10 au plus) */ total?: number };
export type GridReport = {
  expected: number; received: number; missing: number; unknownPrices: number; belowMin: number; aboveMax: number;
  /** 0 à 100 : part des jours attendus qui portent un prix exploitable (ou qui sont réservés / bloqués, donc sans prix à lire). */
  score: number; issues: GridIssue[];
};
const sample = (d: ISODate[]) => d.slice(0, 10);

/**
 * Contrôle de la grille D+0 à D+90 : jours manquants (la plage attendue est complète ou non), prix inconnus sur des nuits libres,
 * prix hors des bornes de la configuration, bornes incohérentes. Ne corrige rien : signale, avec les dates concernées (10 au plus).
 */
export function analyzeGrid(days: PlDay[], range: { from: ISODate; to: ISODate }, config: PricingConfiguration | null): GridReport {
  // un jour en double ou hors de la plage attendue ne compte pas : ni dans les jours lus, ni dans le score
  const byDate = new Map(days.filter((d) => d.date >= range.from && d.date <= range.to).map((d) => [d.date, d]));
  const inRange = [...byDate.values()];
  const missingDates: ISODate[] = [];
  let expected = 0;
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) { expected++; if (!byDate.has(d)) missingDates.push(d); }
  const free = inRange.filter((d) => d.state === "FREE");
  const unknown = free.filter((d) => d.priceCents === null).map((d) => d.date);
  const min = config?.minPriceCents ?? null, max = config?.maxPriceCents ?? null, base = config?.basePriceCents ?? null;
  const below = min === null ? [] : free.filter((d) => d.priceCents !== null && d.priceCents < min).map((d) => d.date);
  const above = max === null ? [] : free.filter((d) => d.priceCents !== null && d.priceCents > max).map((d) => d.date);
  const issues: GridIssue[] = [];
  if (missingDates.length) issues.push({ code: "MISSING_DAYS", severity: "WARN", message: `${missingDates.length} jour${missingDates.length > 1 ? "s" : ""} attendu${missingDates.length > 1 ? "s" : ""} sans donnée de PriceLabs.`, dates: sample(missingDates), total: missingDates.length });
  if (unknown.length) issues.push({ code: "UNKNOWN_PRICES", severity: "WARN", message: `${unknown.length} nuit${unknown.length > 1 ? "s" : ""} libre${unknown.length > 1 ? "s" : ""} sans prix : inconnu, jamais remplacé par zéro.`, dates: sample(unknown), total: unknown.length });
  if (below.length) issues.push({ code: "BELOW_MIN", severity: "WARN", message: `${below.length} prix sous le minimum PriceLabs : la grille lue ne respecte pas la configuration.`, dates: sample(below), total: below.length });
  if (above.length) issues.push({ code: "ABOVE_MAX", severity: "WARN", message: `${above.length} prix au-dessus du maximum PriceLabs.`, dates: sample(above), total: above.length });
  if (min !== null && max !== null && min > max) issues.push({ code: "MIN_ABOVE_MAX", severity: "WARN", message: "Le prix minimum est supérieur au maximum dans PriceLabs." });
  if (base !== null && min !== null && min > base) issues.push({ code: "MIN_ABOVE_BASE", severity: "WARN", message: "Le prix minimum est supérieur au prix de base dans PriceLabs." });
  if (base !== null && max !== null && base > max) issues.push({ code: "BASE_OUTSIDE_BOUNDS", severity: "WARN", message: "Le prix de base est supérieur au maximum dans PriceLabs." });
  if (config && min === null && max === null) issues.push({ code: "NO_BOUNDS", severity: "INFO", message: "PriceLabs ne renvoie ni minimum ni maximum : les bornes de prix sont inconnues." });
  const usable = inRange.filter((d) => d.state !== "FREE" || d.priceCents !== null).length;
  return { expected, received: inRange.length, missing: missingDates.length, unknownPrices: unknown.length, belowMin: below.length, aboveMax: above.length, score: expected ? Math.round((100 * usable) / expected) : 0, issues };
}
