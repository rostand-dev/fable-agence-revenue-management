/**
 * Données de l'écran « Modèles » (lecture seule) : état de chaque modèle du catalogue pour un propriétaire, et coût mensuel par agent avec sa tendance.
 * Module réservé aux pages : aucun agent ne l'importe (il ne décide de rien, il montre).
 */
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { AGENTS } from "@/lib/agents/registry";
import { loadOwnerKeys } from "@/lib/agents/owner-keys";
import { estimateBenchCostUsd, tasksFor } from "./bench";
import { BENCH_AGENT_ID } from "./bench-guard";
import { CATALOG, type CatalogModel } from "./catalog";
import { monthStart, usdToEur } from "./cap-state";
import type { Lifecycle } from "./availability";
import { latestValidated, snapshotToPrice } from "./pricebook";
import type { PriceEntry } from "./prices";

export type ModelState = "deprecie" | "prix_a_verifier" | "qualifie" | "disponible" | "indisponible";
export const MODEL_STATE_LABEL: Record<ModelState, string> = {
  deprecie: "Déprécié ou retiré",
  prix_a_verifier: "Prix à vérifier",
  qualifie: "Qualifié",
  disponible: "Disponible",
  indisponible: "Non disponible avec vos clés",
};

export type ModelRow = {
  model: CatalogModel;
  lifecycle: Lifecycle;
  retiresAt: Date | null;
  /** Le propriétaire a saisi une clé de ce fournisseur */
  hasKey: boolean;
  /** Le modèle figure dans la liste de cette clé */
  available: boolean;
  tasksTotal: number;
  tasksQualified: number;
  tasksSuspended: number;
  /** Date du dernier banc ou contrôle de production */
  evaluatedAt: Date | null;
  price: PriceEntry | null;
  pending: PriceEntry | null;
  /** Relevé de prix en attente (celui que la personne voit et valide) */
  pendingId: string | null;
  state: ModelState;
  /** Coût estimé du banc (USD), null = prix inconnu */
  benchEstimateUsd: number | null;
  benchMaxUsd: number | null;
  benchCalls: number;
};

/** État affiché d'un modèle. Pur : la déprécation prime, puis le prix en attente, puis la qualification ; sans clé ou hors liste, il n'est pas utilisable. */
export function modelState(i: { lifecycle: Lifecycle; hasPending: boolean; available: boolean; tasksTotal: number; tasksQualified: number; tasksSuspended: number }): ModelState {
  if (i.lifecycle === "DEPRECATED" || i.lifecycle === "RETIRED" || i.lifecycle === "ABSENT") return "deprecie";
  if (i.hasPending) return "prix_a_verifier";
  if (!i.available) return "indisponible";
  if (i.tasksTotal > 0 && i.tasksQualified === i.tasksTotal && i.tasksSuspended === 0) return "qualifie";
  return "disponible";
}

export async function modelsOverview(tenantId: string): Promise<ModelRow[]> {
  const [keys, dbModels, quals, validated, pendings] = await Promise.all([
    loadOwnerKeys(tenantId),
    db.select().from(schema.llmModels),
    db.select().from(schema.llmQualifications),
    latestValidated(),
    db.select().from(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.status, "PENDING")),
  ]);
  const pendingBy = new Map(pendings.map((p) => [p.modelId, p]));
  const rows: ModelRow[] = [];
  for (const m of CATALOG) {
    const reg = dbModels.find((x) => x.modelId === m.modelId);
    const key = keys.get(m.provider);
    const mine = quals.filter((q) => q.modelId === m.modelId);
    const total = tasksFor(m.modelId).length;
    const qualified = mine.filter((q) => q.status === "QUALIFIED").length, suspended = mine.filter((q) => q.status === "SUSPENDED").length;
    const lifecycle = (reg?.lifecycle ?? "UNKNOWN") as Lifecycle;
    const available = !!key?.models.some((x) => x.id === m.modelId);
    const v = validated.get(m.modelId), p = pendingBy.get(m.modelId);
    const est = await estimateBenchCostUsd(m.modelId);
    rows.push({
      model: m, lifecycle, retiresAt: reg?.retiresAt ?? null, hasKey: !!key, available, tasksTotal: total, tasksQualified: qualified, tasksSuspended: suspended,
      evaluatedAt: mine.reduce<Date | null>((a, q) => (!a || q.evaluatedAt > a ? q.evaluatedAt : a), null),
      price: v ? snapshotToPrice(v) : null, pending: p ? snapshotToPrice(p) : null, pendingId: p?.id ?? null,
      state: modelState({ lifecycle, hasPending: !!p, available, tasksTotal: total, tasksQualified: qualified, tasksSuspended: suspended }),
      benchEstimateUsd: est.costUsd, benchMaxUsd: est.maxUsd, benchCalls: est.calls,
    });
  }
  return rows;
}

export type Trend = "aucun" | "croissante" | "stable" | "decroissante";
export const TREND_LABEL: Record<Trend, string> = { aucun: "Aucune dépense", croissante: "Croissante", stable: "Stable", decroissante: "Décroissante" };
export const TREND_BAND = 0.15;

/**
 * Tendance du coût : rythme journalier moyen du mois en cours contre celui du mois précédent (un mois entamé n'est pas comparable en cumul).
 * Écart de moins de 15 % = stable. Sans dépense le mois précédent, toute dépense est une hausse. Pur.
 */
export function costTrend(currentUsd: number, previousUsd: number, now: Date): Trend {
  if (currentUsd <= 0 && previousUsd <= 0) return "aucun";
  const dayOfMonth = Math.max((now.getTime() - monthStart(now).getTime()) / 86400_000, 1 / 24); // jours écoulés (fractionnaires) : le 1er à 00:30 ne fausse pas le rythme
  const prevDays = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
  const cur = currentUsd / dayOfMonth, prev = previousUsd / prevDays;
  if (prev <= 0) return "croissante";
  const r = cur / prev;
  return r > 1 + TREND_BAND ? "croissante" : r < 1 - TREND_BAND ? "decroissante" : "stable";
}

export type AgentCostRow = { agentId: string; title: string; calls: number; unpricedCalls: number; currentEur: number; previousEur: number; trend: Trend };

/** Coût du mois par agent (euros), comparé au mois précédent. Les appels sans prix connu sont comptés à part, jamais chiffrés. Le banc des modèles apparaît sur sa propre ligne. */
export async function agentCosts(tenantId: string, now: Date = new Date()): Promise<AgentCostRow[]> {
  const start = monthStart(now), prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  const rows = await db.select({
    agentId: schema.agentRuns.agentId,
    cur: sql<string>`coalesce(sum(${schema.agentRuns.costUsd}) filter (where ${schema.agentRuns.createdAt} >= ${start}), 0)`,
    prev: sql<string>`coalesce(sum(${schema.agentRuns.costUsd}) filter (where ${schema.agentRuns.createdAt} < ${start}), 0)`,
    calls: sql<string>`count(*) filter (where ${schema.agentRuns.createdAt} >= ${start} and ${schema.agentRuns.mode} = 'LLM')`,
    unpriced: sql<string>`count(*) filter (where ${schema.agentRuns.createdAt} >= ${start} and ${schema.agentRuns.mode} = 'LLM' and ${schema.agentRuns.costUsd} is null)`,
  }).from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.tenantId, tenantId), gte(schema.agentRuns.createdAt, prevStart), lt(schema.agentRuns.createdAt, new Date(now.getTime() + 1))))
    .groupBy(schema.agentRuns.agentId);
  const by = new Map(rows.map((r) => [r.agentId, r]));
  const titleOf = (id: string) => (id === BENCH_AGENT_ID ? "Tests de modèles" : AGENTS.find((a) => a.id === id)?.title ?? id);
  const ids = [...AGENTS.map((a) => a.id as string), ...(by.has(BENCH_AGENT_ID) ? [BENCH_AGENT_ID] : [])];
  return ids.map((id) => {
    const r = by.get(id), cur = Number(r?.cur ?? 0), prev = Number(r?.prev ?? 0);
    return { agentId: id, title: titleOf(id), calls: Number(r?.calls ?? 0), unpricedCalls: Number(r?.unpriced ?? 0), currentEur: usdToEur(cur), previousEur: usdToEur(prev), trend: costTrend(cur, prev, now) };
  });
}
