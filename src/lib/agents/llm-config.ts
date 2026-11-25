import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { serverDefaultModel } from "./llm";
import { providerByKey, type GatewayTarget } from "./gateway";
import { isProviderKey, loadOwnerKeys, PROVIDER_KEYS, PROVIDER_LABEL, type OwnerKey } from "./owner-keys";
import { AGENT_BY_ID, type AgentId } from "./registry";
import { catalogById, type ProviderKey } from "../llm-registry/catalog";
import { routableVerdict, type Lifecycle } from "../llm-registry/availability";
import { capFromSettings, capState, monthlySpendUsd } from "../llm-registry/cap-state";
import { getPriceBook } from "../llm-registry/pricebook";
import { profileFor, type TaskId } from "../llm-registry/profiles";
import { route, type Qualification, type RouteReason, type RouteTarget } from "../llm-registry/router";

/**
 * Résolution des cibles de la passerelle pour un agent d'un propriétaire.
 * Le serveur ne détient AUCUNE clé de modèle : seules les clés saisies par le propriétaire servent, chacune pour son fournisseur.
 * Sans clé exploitable, la liste est vide et l'agent retombe sur son repli déterministe.
 */
export type LlmRouting = {
  targets: GatewayTarget[];
  reason: RouteReason;
  /** Modèles retenus, dans l'ordre d'essai, avec leur coût estimé avant l'appel */
  chosen: RouteTarget[];
  /** Coût estimé de la première cible (USD), null si prix inconnu */
  estimatedCostUsd: number | null;
};

const NO_ROUTING = (reason: RouteReason): LlmRouting => ({ targets: [], reason, chosen: [], estimatedCostUsd: null });

let latencyCache: { at: number; map: Map<string, number> } | null = null;
/** Durée moyenne observée par modèle sur 30 jours (agrégat sans donnée personnelle), mise en cache 10 minutes. */
async function observedLatencies(now: Date): Promise<Map<string, number>> {
  if (latencyCache && now.getTime() - latencyCache.at < 600_000) return latencyCache.map;
  const map = new Map<string, number>();
  try {
    const rows = await db.select({ model: schema.agentRuns.model, ms: sql<string>`avg(${schema.agentRuns.durationMs})` }).from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.mode, "LLM"), isNotNull(schema.agentRuns.model), gte(schema.agentRuns.createdAt, new Date(now.getTime() - 30 * 86400_000)))).groupBy(schema.agentRuns.model);
    for (const r of rows) if (r.model) map.set(r.model, Number(r.ms));
  } catch { /* latence inconnue : le départage ignore ce critère */ }
  latencyCache = { at: now.getTime(), map };
  return map;
}
export const resetLatencyCache = () => { latencyCache = null; };

/** Fournisseur d'un modèle choisi à la main : le catalogue, sinon la liste des modèles de l'une des clés du propriétaire, sinon Anthropic (réglages historiques). */
function manualProviderOf(model: string, keys: Map<ProviderKey, OwnerKey>): ProviderKey {
  const c = catalogById(model);
  if (c) return c.provider;
  for (const [p, k] of keys) if (k.models.some((m) => m.id === model)) return p;
  return "anthropic";
}

export async function resolveRouting(tenantId: string, agentId: AgentId | string, opts: { task?: TaskId; now?: Date } = {}): Promise<LlmRouting> {
  const now = opts.now ?? new Date();
  const keys = await loadOwnerKeys(tenantId);
  if (keys.size === 0) return NO_ROUTING("aucune_cle");
  const profile = profileFor(agentId, opts.task);
  const id = AGENT_BY_ID[agentId as AgentId] ? agentId : "direction";
  const [t] = await db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  const manual = ((t?.settings?.agentModels ?? {}) as Record<string, string>)[id] || null;
  const [book, rows, quals, latencyMs] = await Promise.all([
    getPriceBook(),
    db.select().from(schema.llmModels),
    db.select().from(schema.llmQualifications).where(eq(schema.llmQualifications.task, profile.qualifiedBy)),
    observedLatencies(now),
  ]);
  const cap = capFromSettings(t?.settings);
  const capRemainingUsd = cap === null ? null : capState(cap, await monthlySpendUsd(tenantId, now)).remainingUsd;
  const qualifications = new Map<string, Qualification>(quals.filter((q) => q.status === "QUALIFIED" || q.status === "SUSPENDED").map((q) => [q.modelId, { status: q.status as Qualification["status"], score: q.benchScore === null ? null : Number(q.benchScore) }]));
  const ownerModels: Partial<Record<ProviderKey, Set<string>>> = {};
  for (const [p, k] of keys) ownerModels[p] = new Set(k.models.map((m) => m.id));

  const r = route({
    profile, manualModel: manual, manualProvider: manual ? manualProviderOf(manual, keys) : null, ownerProviders: new Set(keys.keys()), ownerModels,
    models: rows.filter((m) => m.provider === "anthropic" || m.provider === "openai" || m.provider === "mistral").map((m) => ({ modelId: m.modelId, provider: m.provider as ProviderKey, tier: m.tier as "eco" | "intermediaire" | "premium", routable: routableVerdict({ ...m, lifecycle: m.lifecycle as Lifecycle }, book.has(m.modelId), now).routable })),
    qualifications, priceBook: book, latencyMs, defaultModel: serverDefaultModel(), capRemainingUsd,
  });
  const targets: GatewayTarget[] = r.targets.map((x) => ({ provider: providerByKey(x.provider), apiKey: keys.get(x.provider)!.apiKey, model: x.modelId, source: "utilisateur" as const }));
  return { targets, reason: r.reason, chosen: r.targets, estimatedCostUsd: r.targets[0]?.estimatedCostUsd ?? null };
}

/** Cibles de la passerelle pour un agent de ce propriétaire (US-070). */
export async function resolveTargets(tenantId: string, agentId: AgentId | string): Promise<GatewayTarget[]> {
  return (await resolveRouting(tenantId, agentId)).targets;
}

export type ProviderStatus = { provider: ProviderKey; keyHint: string; models: { id: string; name: string; createdAt: string | null }[]; modelsFetchedAt: Date | null; verifiedAt: Date | null };
export type LlmStatus = {
  /** « utilisateur » : au moins une clé du propriétaire ; « aucune » : mode déterministe */
  source: "utilisateur" | "aucune";
  providers: ProviderStatus[];
};

/** État de la configuration LLM du propriétaire, sans jamais exposer une clé. */
export async function getLlmStatus(tenantId: string): Promise<LlmStatus> {
  const rows = await db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, tenantId));
  const providers: ProviderStatus[] = rows.filter((c): c is typeof c & { provider: ProviderKey } => isProviderKey(c.provider))
    .map((c) => ({ provider: c.provider, keyHint: c.keyHint, models: c.models, modelsFetchedAt: c.modelsFetchedAt, verifiedAt: c.verifiedAt }))
    .sort((a, b) => PROVIDER_KEYS.indexOf(a.provider) - PROVIDER_KEYS.indexOf(b.provider));
  return { source: providers.length ? "utilisateur" : "aucune", providers };
}

/** Libellé du modèle d'un agent pour l'affichage : le choix manuel, sinon « Automatique » ; null = mode déterministe (aucune clé). Pur. */
export function effectiveModel(source: LlmStatus["source"], agentModel: string | undefined | null): string | null {
  if (source === "aucune") return null;
  return agentModel || "automatique";
}

/** Modèles proposés dans les listes de choix : ceux des clés du propriétaire, préfixés du fournisseur (jamais de doublon). */
export function selectableModels(status: LlmStatus): { id: string; name: string; createdAt: string | null }[] {
  const seen = new Set<string>(), out: { id: string; name: string; createdAt: string | null }[] = [];
  for (const p of status.providers) for (const m of p.models) if (!seen.has(m.id)) { seen.add(m.id); out.push({ id: m.id, name: `${PROVIDER_LABEL[p.provider]} · ${m.name}`, createdAt: m.createdAt }); }
  return out;
}

/** Libellé de l'option « Automatique » des listes de choix de modèle. */
export const AUTO_LABEL = "Automatique (le moins cher qui convient)";
