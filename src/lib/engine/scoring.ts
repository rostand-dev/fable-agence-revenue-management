/**
 * Score de priorité d'un dossier (blueprint §9.2, US-062). Il organise le travail ; il ne contourne jamais un veto (un dossier sous veto passe devant,
 * pour être traité, mais n'ouvre aucune action).
 *
 *   priorité = contribution incrémentale attendue × confiance × facteur d'urgence × poids stratégique − coût d'exécution − pénalité de risque
 *
 * La contribution est exprimée en euros. Les poids, pénalités et coûts sont réglables par espace (Réglages) ; les valeurs par défaut reproduisent
 * le score d'origine (poids 1, aucun coût d'exécution, pénalités 0 / 4 / 10 / 25). Module pur, sans accès base.
 */
import { PLAYBOOK_CODES, type PlaybookCode } from "./playbooks";
import type { Candidate, DetectedOpportunity } from "./types";

export type Risk = Candidate["risk"];
export type ExecutionMode = Candidate["executionMode"];
export const RISKS: Risk[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const EXECUTION_MODES: ExecutionMode[] = ["API_PRICELABS", "MANUAL_RUNBOOK", "INTERNAL", "NONE"];

export type ScoringConfig = {
  /** Poids stratégique par playbook (1 = neutre, 0 = le dossier ne remonte plus par la valeur). */
  strategicWeight: Record<PlaybookCode, number>;
  /** Points retirés au score selon le risque de l'option retenue. */
  riskPenalty: Record<Risk, number>;
  /** Coût de traitement, en euros, selon la façon d'exécuter l'option retenue. */
  executionCost: Record<ExecutionMode, number>;
  /** Points ajoutés à un dossier sous veto : il passe devant pour être traité (jamais pour être exécuté). */
  vetoBoost: number;
};

export const SCORING_LIMITS = { weight: { min: 0, max: 5 }, penalty: { min: 0, max: 1000 }, cost: { min: 0, max: 1000 } } as const;

export const DEFAULT_SCORING: ScoringConfig = {
  strategicWeight: Object.fromEntries(PLAYBOOK_CODES.map((c) => [c, 1])) as Record<PlaybookCode, number>,
  riskPenalty: { LOW: 0, MEDIUM: 4, HIGH: 10, CRITICAL: 25 },
  executionCost: { API_PRICELABS: 0, MANUAL_RUNBOOK: 0, INTERNAL: 0, NONE: 0 },
  vetoBoost: 10000,
};

export type ScoreBreakdown = {
  /** Contribution incrémentale attendue de l'option retenue, en euros (0 si inconnue ou négative). */
  impact: number; confidence: number; urgency: number; weight: number;
  executionCost: number; riskPenalty: number; veto: boolean; score: number;
};

const round1 = (x: number) => Math.round(x * 10) / 10;

export function scoreOpportunity(o: DetectedOpportunity, cfg: ScoringConfig = DEFAULT_SCORING): ScoreBreakdown {
  const c = o.candidates[o.selected];
  const impact = Math.max(0, c?.expectedDeltaCents ?? 0) / 100;
  const weight = cfg.strategicWeight[o.playbook as PlaybookCode] ?? 1;
  const executionCost = c && c.type !== "NO_ACTION" ? cfg.executionCost[c.executionMode] ?? 0 : 0;
  const riskPenalty = cfg.riskPenalty[c?.risk ?? "LOW"];
  const score = round1(impact * o.diagnosis.confidence * o.urgency * weight - executionCost - riskPenalty + (o.veto ? cfg.vetoBoost : 0));
  return { impact: round1(impact), confidence: o.diagnosis.confidence, urgency: round1(o.urgency), weight, executionCost, riskPenalty, veto: o.veto, score };
}
export const priorityScoreWith = (o: DetectedOpportunity, cfg: ScoringConfig = DEFAULT_SCORING) => scoreOpportunity(o, cfg).score;

/* ------------------------------------------------------------ lecture et validation de la configuration */

const num = (v: unknown, lim: { min: number; max: number }): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n >= lim.min && n <= lim.max ? n : null;
};

/** Configuration enregistrée → configuration complète : toute valeur absente ou hors bornes retombe sur la valeur par défaut (jamais sur zéro). */
export function resolveScoring(raw: unknown): ScoringConfig {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const pick = <K extends string>(keys: readonly K[], src: any, def: Record<K, number>, lim: { min: number; max: number }) =>
    Object.fromEntries(keys.map((k) => [k, num(src?.[k], lim) ?? def[k]])) as Record<K, number>;
  return {
    strategicWeight: pick(PLAYBOOK_CODES, r.strategicWeight, DEFAULT_SCORING.strategicWeight, SCORING_LIMITS.weight),
    riskPenalty: pick(RISKS, r.riskPenalty, DEFAULT_SCORING.riskPenalty, SCORING_LIMITS.penalty),
    executionCost: pick(EXECUTION_MODES, r.executionCost, DEFAULT_SCORING.executionCost, SCORING_LIMITS.cost),
    vetoBoost: DEFAULT_SCORING.vetoBoost,
  };
}

/** Saisie d'un formulaire : refuse (avec le champ en cause) plutôt que de corriger en silence. */
export function validateScoringInput(raw: { strategicWeight?: Record<string, unknown>; riskPenalty?: Record<string, unknown>; executionCost?: Record<string, unknown> }):
  { ok: true; config: ScoringConfig } | { ok: false; error: string } {
  const check = (group: string, src: Record<string, unknown> | undefined, lim: { min: number; max: number }, label: (k: string) => string) => {
    for (const [k, v] of Object.entries(src ?? {})) if (num(v, lim) === null) return `${label(k)} : saisissez un nombre entre ${lim.min} et ${lim.max}.`;
    return null;
  };
  const err =
    check("w", raw.strategicWeight, SCORING_LIMITS.weight, (k) => `Poids de ${k}`) ??
    check("r", raw.riskPenalty, SCORING_LIMITS.penalty, (k) => `Pénalité de risque ${k}`) ??
    check("c", raw.executionCost, SCORING_LIMITS.cost, (k) => `Coût d'exécution ${k}`);
  return err ? { ok: false, error: err } : { ok: true, config: resolveScoring(raw) };
}

/** Écarts à la configuration par défaut : seul ce qui diffère est enregistré, pour que les réglages d'origine suivent les évolutions du moteur. */
export function scoringOverrides(cfg: ScoringConfig): Partial<Pick<ScoringConfig, "strategicWeight" | "riskPenalty" | "executionCost">> {
  const diff = <K extends string>(a: Record<K, number>, b: Record<K, number>) => Object.fromEntries((Object.keys(a) as K[]).filter((k) => a[k] !== b[k]).map((k) => [k, a[k]]));
  const out: Record<string, unknown> = {};
  const w = diff(cfg.strategicWeight, DEFAULT_SCORING.strategicWeight), r = diff(cfg.riskPenalty, DEFAULT_SCORING.riskPenalty), c = diff(cfg.executionCost, DEFAULT_SCORING.executionCost);
  if (Object.keys(w).length) out.strategicWeight = w;
  if (Object.keys(r).length) out.riskPenalty = r;
  if (Object.keys(c).length) out.executionCost = c;
  return out;
}
