/**
 * Exécuteur de tâches d'agent (US-074) : prompt versionné → budget → passerelle (US-070) → trace → repli déterministe.
 * Tout agent qui interroge un modèle passe ici ; c'est lui qui garantit qu'un appel est borné, tracé et qu'une panne ne bloque jamais la revue.
 * Il ne fait aucune écriture lui-même : il renvoie la ligne de trace (`run`) que l'appelant doit enregistrer IMMÉDIATEMENT après chaque tâche (le budget du jour se lit dans ces traces).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, newId, schema } from "@/db";
import { checkBudget, budgetDayStart, budgetLimits, type BudgetState } from "./budget";
import { costOfTried, getPriceBook, type PriceBook } from "../llm-registry/pricebook";
import { generateJson, type GatewayFailure, type GatewayMeta } from "./gateway";
import { resolveRouting, type LlmRouting } from "./llm-config";
import { getCapState } from "../llm-registry/cap-state";
import { PROMPTS, promptRef, type PromptId } from "./prompts";
import type { AgentId } from "./registry";

export type FallbackReason = "NO_PROVIDER" | "BUDGET_CALLS" | "BUDGET_TOKENS" | "BUDGET_CAP" | GatewayFailure;
export const FALLBACK_LABEL: Record<string, string> = {
  NO_PROVIDER: "aucune clé de modèle", BUDGET_CAP: "plafond mensuel de dépense atteint", BUDGET_CALLS: "plafond d'appels de la revue atteint", BUDGET_TOKENS: "budget quotidien de jetons atteint",
  BUDGET: "délai ou plafond d'appels de la tâche atteint", PROVIDER_ERROR: "fournisseur indisponible", INVALID_OUTPUT: "sortie du modèle inexploitable",
};

/** Budget d'une revue : plafonds, appels et jetons déjà consommés, cibles de la passerelle mémorisées par agent. */
/** Un repli dû au budget ou à l'absence de fournisseur n'est pas un échec du modèle : pas de délai avant le prochain essai. */
export const retryable = (r: string | null | undefined): boolean => !!r && r !== "NO_PROVIDER" && !r.startsWith("BUDGET_");

/** `capRemainingUsd` : ce qu'il reste du plafond mensuel en USD (null = pas de plafond). Il baisse à chaque appel facturé de la revue. */
export type AgentBudget = BudgetState & { tenantId: string; routings: Map<string, LlmRouting>; capRemainingUsd: number | null };

export async function tokensUsedToday(tenantId: string, now = new Date()): Promise<number> {
  const [r] = await db.select({ n: sql<string>`coalesce(sum(coalesce(${schema.agentRuns.inputTokens}, 0) + coalesce(${schema.agentRuns.outputTokens}, 0)), 0)::bigint` })
    .from(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, tenantId), gte(schema.agentRuns.createdAt, budgetDayStart(now))));
  return Number(r?.n ?? 0);
}

export async function openBudget(tenantId: string, now = new Date(), limits = budgetLimits()): Promise<AgentBudget> {
  const cap = await getCapState(tenantId, now);
  return { tenantId, limits, callsUsed: 0, tokensUsedToday: await tokensUsedToday(tenantId, now), routings: new Map(), capRemainingUsd: cap.remainingUsd };
}

export type AgentTask<T> = {
  budget: AgentBudget;
  agentId: AgentId;
  opportunityId?: string | null;
  /** Opération journalisée (ex. explainAction). */
  operation: string;
  prompt: PromptId;
  user: string;
  schema: z.ZodType<T>;
  /** Résumé de la trace selon l'issue. */
  summary: (r: { mode: "LLM" | "DETERMINISTIC"; reason: FallbackReason | null }) => string;
  /** Version déterministe de la sortie : toujours disponible, jamais fondée sur un modèle. */
  fallback: () => T;
};
export type AgentOutcome<T> = { data: T; mode: "LLM" | "DETERMINISTIC"; reason: FallbackReason | null; meta: GatewayMeta | null; run: typeof schema.agentRuns.$inferInsert };

export async function runAgentTask<T>(task: AgentTask<T>): Promise<AgentOutcome<T>> {
  const b = task.budget, def = PROMPTS[task.prompt], ref = promptRef(task.prompt);
  // routeur : le modèle le moins cher qui convient (ou le choix manuel), avec la clé du propriétaire ; mémorisé par tâche pendant la revue
  const routeKey = task.agentId + "|" + task.prompt;
  let routing = b.routings.get(routeKey);
  if (!routing) { routing = await resolveRouting(b.tenantId, task.agentId, { task: task.prompt }); b.routings.set(routeKey, routing); }
  // plafond mensuel : une cible dont le coût estimé dépasse ce qu'il reste n'est pas appelée (le restant baisse à chaque appel de la revue)
  const targets = routing.targets.filter((_, k) => b.capRemainingUsd === null || routing!.chosen[k]?.estimatedCostUsd == null || routing!.chosen[k].estimatedCostUsd! <= b.capRemainingUsd);
  const base = { id: newId("run"), tenantId: b.tenantId, agentId: task.agentId, opportunityId: task.opportunityId ?? null, operation: task.operation, promptId: ref.id, promptVersion: ref.version, promptHash: ref.hash, createdAt: new Date() };
  const routeTrace = { reason: routing.reason, chosen: routing.chosen.map((c) => ({ model: c.modelId, provider: c.provider, tier: c.tier, estimatedCostUsd: c.estimatedCostUsd })) };
  const estimated = routing.estimatedCostUsd === null ? null : String(routing.estimatedCostUsd);
  // livre de prix chargé après l'appel (jamais pour un repli sans appel) ; un livre vide donne un coût inconnu (null), jamais inventé
  let book: PriceBook = new Map();
  const costOf = (meta: GatewayMeta | null) => {
    const c = meta ? costOfTried(meta.tried, book) : { costUsd: null, snapshotId: null };
    return { costUsd: c.costUsd === null ? null : String(c.costUsd), priceSnapshotId: c.snapshotId };
  };
  const fallback = (reason: FallbackReason, meta: GatewayMeta | null, detail?: string): AgentOutcome<T> => ({
    data: task.fallback(), mode: "DETERMINISTIC", reason, meta,
    run: { ...base, mode: "DETERMINISTIC", model: meta?.tried[0]?.model ?? null, provider: meta?.tried[0]?.provider ?? null, summary: task.summary({ mode: "DETERMINISTIC", reason }), fallbackReason: reason,
      attempts: meta?.attempts ?? 0, repaired: meta?.repaired ?? false, inputTokens: meta?.inputTokens || null, outputTokens: meta?.outputTokens || null, durationMs: meta?.durationMs ?? 0, trace: { route: routeTrace, ...(meta ? { tried: meta.tried } : {}) }, costEstimatedUsd: estimated, ...costOf(meta),
      error: reason === "NO_PROVIDER" || reason.startsWith("BUDGET_") ? null : (detail ?? FALLBACK_LABEL[reason]).slice(0, 200) },
  });
  if (targets.length === 0) return fallback(routing.reason === "plafond_mensuel" || routing.targets.length > 0 ? "BUDGET_CAP" : "NO_PROVIDER", null);
  // plafond mensuel en euros : plus aucun appel de modèle une fois atteint (y compris par les appels de cette revue)
  if (b.capRemainingUsd !== null && b.capRemainingUsd <= 0) return fallback("BUDGET_CAP", null);
  // les traces déjà enregistrées (y compris par une revue parallèle du même propriétaire) comptent avant chaque appel
  b.tokensUsedToday = Math.max(b.tokensUsedToday, await tokensUsedToday(b.tenantId));
  const verdict = checkBudget(b);
  if (!verdict.ok) return fallback(verdict.reason, null);
  const r = await generateJson(targets, { task: task.prompt, system: def.system, user: task.user, schema: task.schema, maxTokens: def.maxTokens });
  // le plafond compte les appels réellement faits au fournisseur (corrections et replis compris), pas les tâches
  book = await getPriceBook();
  b.callsUsed += r.meta.attempts;
  b.tokensUsedToday += r.meta.inputTokens + r.meta.outputTokens;
  const spent = costOf(r.meta).costUsd;
  if (b.capRemainingUsd !== null && spent !== null) b.capRemainingUsd = Math.max(0, b.capRemainingUsd - Number(spent));
  if (!r.ok) return fallback(r.kind, r.meta, r.message);
  return {
    data: r.data, mode: "LLM", reason: null, meta: r.meta,
    run: { ...base, mode: "LLM", model: r.meta.model, provider: r.meta.provider, summary: task.summary({ mode: "LLM", reason: null }), fallbackReason: null, attempts: r.meta.attempts, repaired: r.meta.repaired,
      inputTokens: r.meta.inputTokens, outputTokens: r.meta.outputTokens, durationMs: r.meta.durationMs, trace: { route: routeTrace, tried: r.meta.tried }, costEstimatedUsd: estimated, ...costOf(r.meta) },
  };
}
