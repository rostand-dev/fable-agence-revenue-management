/**
 * Budget des appels de modèle (US-074). Deux plafonds, lus dans l'environnement, qui protègent le coût sans jamais bloquer la revue :
 * quand l'un est atteint, l'agent passe en repli déterministe et la trace dit pourquoi.
 *  - AGENT_MAX_CALLS_PER_REVIEW : appels de modèle au plus par revue (défaut 80) ;
 *  - AGENT_DAILY_TOKEN_BUDGET   : jetons (entrée + sortie) au plus par propriétaire et par jour UTC (défaut 300 000).
 * 0 désactive les appels de modèle des agents ; une valeur invalide revient au défaut. Module pur.
 */
export const DEFAULT_CALLS_PER_REVIEW = 80;
export const DEFAULT_DAILY_TOKENS = 300_000;
const MAX = 100_000_000;

function intOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "" || !/^\d+$/.test(raw.trim())) return fallback;
  const n = Number(raw.trim());
  return n <= MAX ? n : fallback;
}

export type BudgetLimits = { callsPerReview: number; dailyTokens: number };
export function budgetLimits(env: Record<string, string | undefined> = process.env): BudgetLimits {
  return { callsPerReview: intOr(env.AGENT_MAX_CALLS_PER_REVIEW, DEFAULT_CALLS_PER_REVIEW), dailyTokens: intOr(env.AGENT_DAILY_TOKEN_BUDGET, DEFAULT_DAILY_TOKENS) };
}

export type BudgetState = { limits: BudgetLimits; callsUsed: number; tokensUsedToday: number };
export type BudgetVerdict = { ok: true } | { ok: false; reason: "BUDGET_CALLS" | "BUDGET_TOKENS" };

/** Un appel est permis tant que les deux plafonds ne sont pas atteints (le dernier appel peut les dépasser : on ne coupe jamais une réponse en cours). */
export function checkBudget(s: BudgetState): BudgetVerdict {
  if (s.callsUsed >= s.limits.callsPerReview) return { ok: false, reason: "BUDGET_CALLS" };
  if (s.tokensUsedToday >= s.limits.dailyTokens) return { ok: false, reason: "BUDGET_TOKENS" };
  return { ok: true };
}

/** Début du jour UTC du budget quotidien. */
export const budgetDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
