import { createHash } from "node:crypto";
import { floorGrid } from "./engine/economics";
import type { EconomicModel } from "./engine/types";

/**
 * Conditions d'activation tirées du blueprint (§6.1, §18.3) : observation d'une durée minimale configurable (14 jours par défaut), floors validés par une personne,
 * échantillon de réservations rapproché. Une information inconnue ne valide jamais une condition.
 */
export const SHADOW_MIN_DAYS_DEFAULT = 14;
export const SHADOW_MIN_DAYS_MAX = 90;
/**
 * Durée minimale d'observation avant activation, en jours : variable ACTIVATION_SHADOW_MIN_DAYS (14 par défaut, de 0 à 90).
 * Une valeur absente, vide, non entière ou hors plage revient à 14 : une faute de frappe ne doit jamais raccourcir l'observation.
 * 0 supprime le délai (la date de lancement doit toujours être connue).
 */
export function shadowMinDays(raw: string | undefined = process.env.ACTIVATION_SHADOW_MIN_DAYS): number {
  const v = (raw ?? "").trim();
  if (!/^\d+$/.test(v)) return SHADOW_MIN_DAYS_DEFAULT;
  const n = Number(v);
  return n <= SHADOW_MIN_DAYS_MAX ? n : SHADOW_MIN_DAYS_DEFAULT;
}
export const RECONCILIATION_MIN_SAMPLE = 10;
export const RECONCILIATION_MAX_GAP_PCT = 1;
export const FLOOR_LOS = [2, 7, 28] as const;
const DAY = 86_400_000;

export type ShadowState = { status: "OK" | "WAITING" | "UNKNOWN"; days: number | null; readyAt: string | null; minDays: number };
/** Durée d'observation écoulée depuis le lancement (`onboarding.completedAt`). */
export function shadowState(completedAt: string | null | undefined, now = Date.now(), minDays = shadowMinDays()): ShadowState {
  const t = completedAt ? Date.parse(completedAt) : NaN;
  if (!Number.isFinite(t)) return { status: "UNKNOWN", days: null, readyAt: null, minDays };
  const days = Math.max(0, Math.floor((now - t) / DAY));
  const readyAt = new Date(t + minDays * DAY).toISOString();
  return { status: now - t >= minDays * DAY ? "OK" : "WAITING", days, readyAt, minDays };
}

/** Empreinte de la grille de planchers (canal × 2/7/28 nuits) : change dès qu'un coût, une commission ou une contribution change. `null` si le modèle est incomplet. */
export function floorFingerprint(m: EconomicModel): string | null {
  try {
    const grid = floorGrid(m, [...FLOOR_LOS]).map((g) => [g.channel, g.nights, g.hardCents, g.strategyCents]).sort((a, b) => (a[0] as string).localeCompare(b[0] as string) || (a[1] as number) - (b[1] as number)); // ordre canonique : ne dépend pas de l'ordre des clés du modèle
    if (!grid.length || grid.some((g) => !Number.isFinite(g[2] as number) || !Number.isFinite(g[3] as number))) return null;
    return createHash("sha256").update(JSON.stringify(grid)).digest("hex").slice(0, 32);
  } catch { return null; }
}

export type FloorsState = { status: "OK" | "NONE" | "STALE" | "INCOMPLETE"; by: string | null; at: string | null };
export type ValidationRow = { fingerprint: string | null; validatedByName: string; createdAt: string };
export function floorsState(latest: ValidationRow | null, currentFingerprint: string | null): FloorsState {
  if (currentFingerprint === null) return { status: "INCOMPLETE", by: null, at: null };
  if (!latest) return { status: "NONE", by: null, at: null };
  return { status: latest.fingerprint === currentFingerprint ? "OK" : "STALE", by: latest.validatedByName, at: latest.createdAt };
}

export type ReconciliationInput = { sampleSize: number; maxGapPct: number; source: string; note: string | null };
export type ReconciliationParse = { ok: true; value: ReconciliationInput } | { ok: false; error: string };
export function parseReconciliation(raw: Record<string, unknown>): ReconciliationParse {
  // Saisie stricte : un nombre décimal simple (virgule ou point), pas de notation scientifique, hexadécimale ni de séparateur de milliers.
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+([.,]\d+)?$/.test(v.trim()) ? Number(v.trim().replace(",", ".")) : NaN);
  const size = num(raw.sampleSize), gap = num(raw.maxGapPct);
  const text = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v.trim() : null);
  const source = text(raw.source), note = text(raw.note);
  if (source === null || note === null) return { ok: false, error: "Source et commentaire : du texte uniquement." };
  if (!Number.isInteger(size) || size < 1 || size > 1000) return { ok: false, error: "Taille de l'échantillon : un nombre entier de réservations entre 1 et 1000." };
  if (!Number.isFinite(gap) || gap < 0 || gap > 100) return { ok: false, error: "Écart maximal constaté : un pourcentage entre 0 et 100 (0 si les montants concordent)." };
  if (source.length < 2 || source.length > 120) return { ok: false, error: "Source du rapprochement : 2 à 120 caractères (par exemple « SuperHote comparé aux relevés Airbnb et Booking »)." };
  if (note.length > 300) return { ok: false, error: "Commentaire : 300 caractères au maximum." };
  return { ok: true, value: { sampleSize: size, maxGapPct: gap, source, note: note || null } };
}

export type ReconciliationState = { status: "OK" | "NONE" | "TOO_SMALL" | "GAP"; sampleSize: number | null; maxGapPct: number | null; by: string | null; at: string | null };
export function reconciliationState(latest: { payload: Partial<ReconciliationInput>; validatedByName: string; createdAt: string } | null): ReconciliationState {
  if (!latest) return { status: "NONE", sampleSize: null, maxGapPct: null, by: null, at: null };
  const { sampleSize, maxGapPct } = latest.payload;
  const base = { sampleSize: sampleSize ?? null, maxGapPct: maxGapPct ?? null, by: latest.validatedByName, at: latest.createdAt };
  if (typeof sampleSize !== "number" || typeof maxGapPct !== "number") return { ...base, status: "NONE" };
  if (sampleSize < RECONCILIATION_MIN_SAMPLE) return { ...base, status: "TOO_SMALL" };
  if (maxGapPct > RECONCILIATION_MAX_GAP_PCT) return { ...base, status: "GAP" };
  return { ...base, status: "OK" };
}
