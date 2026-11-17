import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptSecret } from "../secret";
import { serverDefaultModel, type LlmConfig } from "./llm";
import { AGENT_BY_ID, type AgentId } from "./registry";

/**
 * Résolution pure (testable) : quelle clé, quel modèle pour un agent.
 * - clé : celle de l'utilisateur, sinon celle du serveur, sinon aucune (repli déterministe) ;
 * - modèle : celui choisi pour l'agent (seulement avec la clé de l'utilisateur, seule garantie qu'elle y a accès),
 *   sinon le modèle par défaut du serveur.
 */
export function pickLlmConfig(input: { userKey: string | null; serverKey: string | undefined; agentModel: string | undefined | null; defaultModel: string }): LlmConfig | null {
  if (input.userKey) return { apiKey: input.userKey, model: input.agentModel || input.defaultModel, source: "utilisateur" };
  if (input.serverKey) return { apiKey: input.serverKey, model: input.defaultModel, source: "serveur" };
  return null;
}

export type LlmStatus = { source: "utilisateur" | "serveur" | "aucune"; keyHint: string | null; models: { id: string; name: string; createdAt: string | null }[]; modelsFetchedAt: Date | null; verifiedAt: Date | null };

/** État de la configuration LLM du propriétaire, sans jamais exposer la clé. */
export async function getLlmStatus(tenantId: string): Promise<LlmStatus> {
  const [c] = await db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, tenantId));
  if (c) return { source: "utilisateur", keyHint: c.keyHint, models: c.models, modelsFetchedAt: c.modelsFetchedAt, verifiedAt: c.verifiedAt };
  return { source: process.env.ANTHROPIC_API_KEY ? "serveur" : "aucune", keyHint: null, models: [], modelsFetchedAt: null, verifiedAt: null };
}

/** Clé et modèle d'un agent pour ce propriétaire, ou null (repli déterministe). */
export async function resolveLlm(tenantId: string, agentId: AgentId | string): Promise<LlmConfig | null> {
  const [c] = await db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, tenantId));
  let userKey: string | null = null;
  if (c) { try { userKey = decryptSecret(c.apiKeyEnc); } catch { userKey = null; } }
  const [t] = await db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  const models = (t?.settings?.agentModels ?? {}) as Record<string, string>;
  const id = AGENT_BY_ID[agentId as AgentId] ? agentId : "direction";
  return pickLlmConfig({ userKey, serverKey: process.env.ANTHROPIC_API_KEY, agentModel: models[id], defaultModel: serverDefaultModel() });
}

/** Modèle effectif d'un agent pour l'affichage (null = mode déterministe). Pur : ne touche ni la base ni le réseau. */
export function effectiveModel(source: LlmStatus["source"], agentModel: string | undefined | null, defaultModel: string): string | null {
  if (source === "aucune") return null;
  return source === "utilisateur" ? agentModel || defaultModel : defaultModel;
}
