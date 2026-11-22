/**
 * Exécuteur de tâches d'agent (US-074) : prompt versionné → budget → passerelle (US-070) → trace → repli déterministe.
 * Tout agent qui interroge un modèle passe ici ; c'est lui qui garantit qu'un appel est borné, tracé et qu'une panne ne bloque jamais la revue.
 * Il ne fait aucune écriture lui-même : il renvoie la ligne de trace (`run`) que l'appelant doit enregistrer IMMÉDIATEMENT après chaque tâche (le budget du jour se lit dans ces traces).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, newId, schema } from "@/db";
import { checkBudget, budgetDayStart, budgetLimits, type BudgetState } from "./budget";
import { generateJson, type GatewayFailure, type GatewayMeta, type GatewayTarget } from "./gateway";
import { resolveTargets } from "./llm-config";
import { PROMPTS, promptRef, type PromptId } from "./prompts";
import type { AgentId } from "./registry";

export type FallbackReason = "NO_PROVIDER" | "BUDGET_CALLS" | "BUDGET_TOKENS" | GatewayFailure;
export const FALLBACK_LABEL: Record<string, string> = {
  NO_PROVIDER: "aucune clé de modèle", BUDGET_CALLS: "plafond d'appels de la revue atteint", BUDGET_TOKENS: "budget quotidien de jetons atteint",
  BUDGET: "délai ou plafond d'appels de la tâche atteint", PROVIDER_ERROR: "fournisseur indisponible", INVALID_OUTPUT: "sortie du modèle inexploitable",
};

/** Budget d'une revue : plafonds, appels et jetons déjà consommés, cibles de la passerelle mémorisées par agent. */
export type AgentBudget = BudgetState & { tenantId: string; targets: Map<string, GatewayTarget[]> };

export async function tokensUsedToday(tenantId: string, now = new Date()): Promise<number> {
  const [r] = await db.select({ n: sql<string>`coalesce(sum(coalesce(${schema.agentRuns.inputTokens}, 0) + coalesce(${schema.agentRuns.outputTokens}, 0)), 0)::bigint` })
    .from(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, tenantId), gte(schema.agentRuns.createdAt, budgetDayStart(now))));
  return Number(r?.n ?? 0);
}

export async function openBudget(tenantId: string, now = new Date(), limits = budgetLimits()): Promise<AgentBudget> {
  return { tenantId, limits, callsUsed: 0, tokensUsedToday: await tokensUsedToday(tenantId, now), targets: new Map() };
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
  let targets = b.targets.get(task.agentId);
  if (!targets) { targets = await resolveTargets(b.tenantId, task.agentId); b.targets.set(task.agentId, targets); }
  const base = { id: newId("run"), tenantId: b.tenantId, agentId: task.agentId, opportunityId: task.opportunityId ?? null, operation: task.operation, promptId: ref.id, promptVersion: ref.version, promptHash: ref.hash, createdAt: new Date() };
  const fallback = (reason: FallbackReason, meta: GatewayMeta | null, detail?: string): AgentOutcome<T> => ({
    data: task.fallback(), mode: "DETERMINISTIC", reason, meta,
    run: { ...base, mode: "DETERMINISTIC", model: meta?.tried[0]?.model ?? null, provider: meta?.tried[0]?.provider ?? null, summary: task.summary({ mode: "DETERMINISTIC", reason }), fallbackReason: reason,
      attempts: meta?.attempts ?? 0, repaired: meta?.repaired ?? false, inputTokens: meta?.inputTokens || null, outputTokens: meta?.outputTokens || null, durationMs: meta?.durationMs ?? 0, trace: meta ? { tried: meta.tried } : null,
      error: reason === "NO_PROVIDER" || reason.startsWith("BUDGET_") ? null : (detail ?? FALLBACK_LABEL[reason]).slice(0, 200) },
  });
  if (targets.length === 0) return fallback("NO_PROVIDER", null);
  // les traces déjà enregistrées (y compris par une revue parallèle du même propriétaire) comptent avant chaque appel
  b.tokensUsedToday = Math.max(b.tokensUsedToday, await tokensUsedToday(b.tenantId));
  const verdict = checkBudget(b);
  if (!verdict.ok) return fallback(verdict.reason, null);
  const r = await generateJson(targets, { task: task.prompt, system: def.system, user: task.user, schema: task.schema, maxTokens: def.maxTokens });
  // le plafond compte les appels réellement faits au fournisseur (corrections et replis compris), pas les tâches
  b.callsUsed += r.meta.attempts;
  b.tokensUsedToday += r.meta.inputTokens + r.meta.outputTokens;
  if (!r.ok) return fallback(r.kind, r.meta, r.message);
  return {
    data: r.data, mode: "LLM", reason: null, meta: r.meta,
    run: { ...base, mode: "LLM", model: r.meta.model, provider: r.meta.provider, summary: task.summary({ mode: "LLM", reason: null }), fallbackReason: null, attempts: r.meta.attempts, repaired: r.meta.repaired,
      inputTokens: r.meta.inputTokens, outputTokens: r.meta.outputTokens, durationMs: r.meta.durationMs, trace: { tried: r.meta.tried } },
  };
}
