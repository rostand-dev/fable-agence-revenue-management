/**
 * Stratégie d'un logement (US-023) : réglages que le Strategy Builder fait évoluer, comparaison de deux stratégies, validation.
 * Fonctions pures. Les prix de base, minimum et maximum sont pilotés par PriceLabs et par les actions approuvées : ils figurent dans
 * l'historique et la comparaison, mais le Builder ne les édite pas.
 */
import type { Strategy } from "./engine/types";

export type StrategyChange = { key: string; label: string; from: string | null; to: string | null };
export type BuilderValues = { objective: string | null; positioning: string | null; minStay: number | null; maxDiscountStackPct: number; maxPriceChangePct: number };
export const BUILDER_KEYS = ["objective", "positioning", "minStay", "maxDiscountStackPct", "maxPriceChangePct"] as const satisfies readonly (keyof BuilderValues)[];
export const STRATEGY_SOURCE_LABEL: Record<string, string> = { BUILDER: "Strategy Builder", FORM: "Dossier du logement", PRICELABS_SYNC: "Relecture PriceLabs", ACTION: "Action approuvée", ACTION_ROLLBACK: "Annulation d'une action", ROLLBACK: "Restauration d'une version", SYSTEM: "Version de départ" };
export const DEFAULT_MAX_DISCOUNT_STACK_PCT = 20, DEFAULT_MAX_PRICE_CHANGE_PCT = 5;

const eur = (c: number | null | undefined) => (c == null ? null : `${(c / 100).toFixed(2).replace(".", ",")} €`);
const pct = (n: number | null | undefined) => (n == null ? null : `${String(n).replace(".", ",")} %`);
const nights = (n: number | null | undefined) => (n == null ? null : `${n} nuit${n > 1 ? "s" : ""}`);

/** Ce qui change entre deux stratégies, en clair. */
export function diffStrategy(prev: Partial<Strategy> | null | undefined, next: Partial<Strategy>): StrategyChange[] {
  const out: StrategyChange[] = [];
  const push = (key: string, label: string, a: string | null, b: string | null) => { if (a !== b) out.push({ key, label, from: a, to: b }); };
  push("objective", "Objectif", prev?.objective || null, next.objective || null);
  push("positioning", "Positionnement", prev?.positioning || null, next.positioning || null);
  push("basePriceCents", "Prix de base", eur(prev?.basePriceCents), eur(next.basePriceCents));
  push("minPriceCents", "Prix minimum", eur(prev?.minPriceCents), eur(next.minPriceCents));
  push("maxPriceCents", "Prix maximum", eur(prev?.maxPriceCents), eur(next.maxPriceCents));
  push("minStay", "Séjour minimum", nights(prev?.minStay), nights(next.minStay));
  push("maxDiscountStackPct", "Cumul de remises maximal", pct(prev?.maxDiscountStackPct ?? DEFAULT_MAX_DISCOUNT_STACK_PCT), pct(next.maxDiscountStackPct ?? DEFAULT_MAX_DISCOUNT_STACK_PCT));
  push("maxPriceChangePct", "Variation de prix sans validation renforcée", pct(prev?.maxPriceChangePct ?? DEFAULT_MAX_PRICE_CHANGE_PCT), pct(next.maxPriceChangePct ?? DEFAULT_MAX_PRICE_CHANGE_PCT));
  return out;
}

export const builderValuesOf = (s: Partial<Strategy>): BuilderValues => ({
  objective: s.objective || null, positioning: s.positioning || null, minStay: s.minStay ?? null,
  maxDiscountStackPct: s.maxDiscountStackPct ?? DEFAULT_MAX_DISCOUNT_STACK_PCT, maxPriceChangePct: s.maxPriceChangePct ?? DEFAULT_MAX_PRICE_CHANGE_PCT,
});
/** Applique des réglages du Builder à une stratégie ; les prix ne bougent jamais. */
export const applyBuilderValues = (s: Strategy, v: BuilderValues): Strategy => ({ ...s, objective: v.objective ?? undefined, positioning: v.positioning ?? undefined, minStay: v.minStay, maxDiscountStackPct: v.maxDiscountStackPct, maxPriceChangePct: v.maxPriceChangePct });

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const text = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v: unknown): number | null | "bad" => { if (v == null || v === "") return null; const n = typeof v === "number" ? v : Number(String(v).replace(",", ".").trim()); return Number.isFinite(n) ? n : "bad"; };

/** Réglages saisis : mêmes bornes pour le formulaire et l'API. Un champ absent de `raw` garde la valeur de `current`. */
export function parseBuilderValues(raw: Record<string, unknown>, current: BuilderValues): Parsed<BuilderValues> {
  const v: BuilderValues = { ...current };
  if ("objective" in raw) { const t = text(raw.objective); if (t.length > 160) return { ok: false, error: "L'objectif est limité à 160 caractères." }; v.objective = t || null; }
  if ("positioning" in raw) { const t = text(raw.positioning); if (t.length > 120) return { ok: false, error: "Le positionnement est limité à 120 caractères." }; v.positioning = t || null; }
  if ("minStay" in raw) { const n = num(raw.minStay); if (n === "bad" || (n !== null && (!Number.isInteger(n) || n < 1 || n > 30))) return { ok: false, error: "Le séjour minimum est un nombre entier de nuits, de 1 à 30 (vide si inconnu)." }; v.minStay = n; }
  if ("maxDiscountStackPct" in raw) { const n = num(raw.maxDiscountStackPct); if (n === "bad" || n === null || n < 0 || n > 50) return { ok: false, error: "Le cumul de remises maximal est un pourcentage de 0 à 50." }; v.maxDiscountStackPct = n; }
  if ("maxPriceChangePct" in raw) { const n = num(raw.maxPriceChangePct); if (n === "bad" || n === null || n < 1 || n > 30) return { ok: false, error: "La variation de prix sans validation renforcée est un pourcentage de 1 à 30." }; v.maxPriceChangePct = n; }
  return { ok: true, value: v };
}
