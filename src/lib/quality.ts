import type { MappingStatus } from "./mapping";

/**
 * Checklist de qualité d'un logement (US-024). Elle décide du passage Observation → Actif :
 * un point BLOQUANT non satisfait interdit l'activation ; un point d'AVERTISSEMENT ne la bloque pas mais reste affiché.
 * Une information inconnue ne valide jamais un point (aucune valeur supposée).
 */
export type QualityKey = "identity" | "pricelabs" | "calendar" | "economics" | "mapping" | "prices" | "superhote" | "provisional";
export type QualitySeverity = "BLOCKING" | "ADVISORY";
export type CalendarState = { status: "OK" | "NEVER" | "FAILED" | "STALE"; days: number | null; at: string | null };
/** Une lecture n'atteste la grille que si elle a réussi, porte des jours, et date de moins de 48 h. */
export const CALENDAR_MAX_AGE_MS = 48 * 3600_000;
export function calendarStateOf(lastSync: { ok?: boolean; at?: string; days?: number } | null | undefined, now = Date.now()): CalendarState {
  if (!lastSync) return { status: "NEVER", days: null, at: null };
  const at = lastSync.at ?? null;
  if (lastSync.ok !== true) return { status: "FAILED", days: null, at };
  if (!(typeof lastSync.days === "number" && lastSync.days > 0)) return { status: "NEVER", days: null, at };
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t) || now - t > CALENDAR_MAX_AGE_MS) return { status: "STALE", days: lastSync.days, at };
  return { status: "OK", days: lastSync.days, at };
}
const CALENDAR_DETAIL = (c: CalendarState) => c.status === "OK" ? `${c.days} jours lus à la dernière lecture.` : c.status === "FAILED" ? "La dernière lecture PriceLabs a échoué : relancez-la." : c.status === "STALE" ? "La dernière lecture date de plus de 48 h : relancez-la." : "La grille de prix n'a pas encore été lue : lancez une lecture PriceLabs.";

export type QualityFacts = {
  identityOk: boolean;
  pricelabsLinked: boolean;
  /** État de la dernière lecture de la grille PriceLabs. */
  calendar: CalendarState;
  economicsMissing: number;
  mappingStatus: MappingStatus;
  prices: { basePriceCents: number | null; minPriceCents: number | null; maxPriceCents: number | null };
  superhoteLinked: boolean;
  provisionalCount: number;
};
export type QualityFix = "dossier" | "pricelabs" | "superhote" | "couts" | "mapping";
export type QualityItem = { key: QualityKey; label: string; severity: QualitySeverity; ok: boolean; detail: string; fix: QualityFix };
export type QualityReport = { items: QualityItem[]; blockers: QualityKey[]; warnings: QualityKey[]; canActivate: boolean };

const MAPPING_DETAIL: Record<MappingStatus, string> = {
  CONFIRMED: "Rattachements confirmés par une personne.",
  TO_CONFIRM: "Rattachements à confirmer : relisez-les puis confirmez.",
  STALE: "Les rattachements ont changé depuis la dernière confirmation : à confirmer de nouveau.",
  INCOMPLETE: "Rattachements incomplets : l'annonce PriceLabs manque.",
};

/** Cohérence des prix : base et minimum connus, minimum ≤ base, base ≤ maximum quand celui-ci est connu. */
export function pricesProblem(p: QualityFacts["prices"]): string | null {
  const { basePriceCents: b, minPriceCents: m, maxPriceCents: x } = p;
  if (b == null || b <= 0) return "prix de base inconnu";
  if (m == null || m <= 0) return "prix minimum inconnu";
  if (m > b) return "le prix minimum dépasse le prix de base";
  if (x != null && x <= 0) return "le prix maximum est invalide";
  if (x != null && x < b) return "le prix maximum est inférieur au prix de base";
  return null;
}

export function evaluateQuality(f: QualityFacts): QualityReport {
  const prices = pricesProblem(f.prices);
  const items: QualityItem[] = [
    { key: "identity", label: "Identité du logement", severity: "BLOCKING", ok: f.identityOk, fix: "dossier", detail: f.identityOk ? "Nom, ville et type renseignés." : "Nom, ville ou type manquant." },
    { key: "pricelabs", label: "Annonce PriceLabs rattachée", severity: "BLOCKING", ok: f.pricelabsLinked, fix: "pricelabs", detail: f.pricelabsLinked ? "Annonce rattachée." : "Aucune annonce PriceLabs rattachée : sans calendrier de prix, rien ne peut être appliqué." },
    { key: "calendar", label: "Grille de prix lue", severity: "BLOCKING", ok: f.calendar.status === "OK", fix: "pricelabs", detail: CALENDAR_DETAIL(f.calendar) },
    { key: "economics", label: "Modèle économique complet", severity: "BLOCKING", ok: f.economicsMissing === 0, fix: "couts", detail: f.economicsMissing === 0 ? "Tous les coûts et seuils sont renseignés." : `${f.economicsMissing} valeur${f.economicsMissing > 1 ? "s" : ""} manquante${f.economicsMissing > 1 ? "s" : ""} (coûts et seuils).` },
    { key: "mapping", label: "Mapping des identifiants confirmé", severity: "BLOCKING", ok: f.mappingStatus === "CONFIRMED", fix: "mapping", detail: MAPPING_DETAIL[f.mappingStatus] },
    { key: "prices", label: "Prix de base et minimum cohérents", severity: "BLOCKING", ok: prices === null, fix: "pricelabs", detail: prices === null ? "Prix de base, minimum et maximum cohérents." : `Incohérence : ${prices}.` },
    { key: "superhote", label: "SuperHote rattaché", severity: "ADVISORY", ok: f.superhoteLinked, fix: "superhote", detail: f.superhoteLinked ? "Réservations lues via SuperHote." : "Non rattaché : les réservations sont lues via PriceLabs, moins fiable." },
    { key: "provisional", label: "Valeurs économiques confirmées", severity: "ADVISORY", ok: f.provisionalCount === 0, fix: "couts", detail: f.provisionalCount === 0 ? "Aucune valeur provisoire." : `${f.provisionalCount} valeur${f.provisionalCount > 1 ? "s" : ""} provisoire${f.provisionalCount > 1 ? "s" : ""} à confirmer.` },
  ];
  const blockers = items.filter((i) => i.severity === "BLOCKING" && !i.ok).map((i) => i.key);
  const warnings = items.filter((i) => i.severity === "ADVISORY" && !i.ok).map((i) => i.key);
  return { items, blockers, warnings, canActivate: blockers.length === 0 };
}
