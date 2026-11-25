/**
 * Contrôles avant un test de modèle (bouton « Tester ce modèle ») : un test appelle de vrais modèles avec la clé du propriétaire, donc il coûte.
 * Refusé si le modèle est inconnu, sans clé, absent de la liste de la clé, sans prix connu (coût non chiffrable), si le plafond mensuel est atteint
 * ou serait dépassé, ou si la cadence est dépassée. Module d'écriture de l'espace (jamais importé par un agent).
 */
import { and, eq, gte } from "drizzle-orm";
import { db, schema } from "@/db";
import { loadOwnerKeys, PROVIDER_LABEL, type OwnerKey } from "@/lib/agents/owner-keys";
import { BENCH_HOURLY_LIMIT, BENCH_MODEL_COOLDOWN_MIN, estimateBenchCostUsd } from "./bench";
import { getCapState, usdToEur } from "./cap-state";
import { catalogById, type CatalogModel } from "./catalog";

/** Identifiant de la ligne de trace (agent_runs) des tests de modèles. */
export const BENCH_AGENT_ID = "banc";
const eur = (usd: number) => usdToEur(usd).toLocaleString("fr-FR", { maximumFractionDigits: 4 });

export type BenchPreflight = { ok: true; model: CatalogModel; key: OwnerKey; estimateUsd: number } | { ok: false; error: string };

export async function benchPreflight(tenantId: string, modelId: string, now: Date = new Date()): Promise<BenchPreflight> {
  const m = catalogById(modelId);
  if (!m) return { ok: false, error: "Modèle inconnu." };
  const key = (await loadOwnerKeys(tenantId)).get(m.provider);
  if (!key) return { ok: false, error: `Saisissez d'abord votre clé API ${PROVIDER_LABEL[m.provider]} dans Intégrations : le test utilise votre clé.` };
  if (!key.models.some((x) => x.id === m.modelId)) return { ok: false, error: `${m.label} ne figure pas dans la liste de votre clé. Actualisez la liste des modèles dans Intégrations.` };
  const est = await estimateBenchCostUsd(m.modelId);
  if (est.costUsd === null) return { ok: false, error: "Le prix de ce modèle n'est pas connu : le coût du test ne peut pas être chiffré, il n'est donc pas lancé." };
  const cap = await getCapState(tenantId, now);
  if (cap.level === "reached") return { ok: false, error: "Le plafond mensuel de dépense est atteint : aucun test n'est lancé avant le 1er du mois prochain (UTC), ou relevez le plafond." };
  if (cap.remainingUsd !== null && est.costUsd > cap.remainingUsd) return { ok: false, error: `Ce test (≈ ${eur(est.costUsd)} €) dépasserait le plafond mensuel restant. Relevez le plafond pour le lancer.` };
  const recent = await db.select({ model: schema.agentRuns.model, at: schema.agentRuns.createdAt }).from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.tenantId, tenantId), eq(schema.agentRuns.agentId, BENCH_AGENT_ID), gte(schema.agentRuns.createdAt, new Date(now.getTime() - 3600_000))));
  const cool = new Date(now.getTime() - BENCH_MODEL_COOLDOWN_MIN * 60_000);
  if (recent.some((r) => r.model === m.modelId && r.at >= cool)) return { ok: false, error: `${m.label} a déjà été testé il y a moins de ${BENCH_MODEL_COOLDOWN_MIN} minutes. Réessayez plus tard.` };
  if (recent.length >= BENCH_HOURLY_LIMIT) return { ok: false, error: `Limite atteinte : ${BENCH_HOURLY_LIMIT} tests par heure. Réessayez plus tard.` };
  return { ok: true, model: m, key, estimateUsd: est.costUsd };
}
