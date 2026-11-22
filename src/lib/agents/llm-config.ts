import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptSecret } from "../secret";
import { serverDefaultModel, type LlmConfig } from "./llm";
import { anthropicProvider, openaiProvider, type GatewayTarget } from "./gateway";
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

/** Repli OpenAI du serveur : actif seulement si la clé ET le modèle sont définis (aucun nom de modèle n'est deviné). */
export function openaiFallbackFrom(env: Record<string, string | undefined> = process.env): { apiKey: string; model: string } | null {
  const apiKey = env.OPENAI_API_KEY?.trim(), model = env.OPENAI_MODEL?.trim();
  return apiKey && model ? { apiKey, model } : null;
}

/**
 * Cibles ordonnées de la passerelle (US-070) pour un agent : Anthropic d'abord (clé du propriétaire, sinon clé du serveur), puis le repli OpenAI du serveur s'il est configuré.
 * Pur et testable. Liste vide = aucun fournisseur : l'appelant retombe sur son repli déterministe.
 */
export function buildTargets(input: { primary: LlmConfig | null; openai: { apiKey: string; model: string } | null }): GatewayTarget[] {
  const out: GatewayTarget[] = [];
  if (input.primary) out.push({ provider: anthropicProvider, apiKey: input.primary.apiKey, model: input.primary.model, source: input.primary.source });
  if (input.openai) out.push({ provider: openaiProvider, apiKey: input.openai.apiKey, model: input.openai.model, source: "serveur" });
  return out;
}

export type LlmStatus = { source: "utilisateur" | "serveur" | "aucune"; /** Repli OpenAI du serveur configuré (modèle) ou null */ fallbackModel: string | null; keyHint: string | null; models: { id: string; name: string; createdAt: string | null }[]; modelsFetchedAt: Date | null; verifiedAt: Date | null };

/** État de la configuration LLM du propriétaire, sans jamais exposer la clé. */
export async function getLlmStatus(tenantId: string): Promise<LlmStatus> {
  const [c] = await db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, tenantId));
  if (c) return { source: "utilisateur", fallbackModel: openaiFallbackFrom()?.model ?? null, keyHint: c.keyHint, models: c.models, modelsFetchedAt: c.modelsFetchedAt, verifiedAt: c.verifiedAt };
  return { source: process.env.ANTHROPIC_API_KEY ? "serveur" : "aucune", fallbackModel: openaiFallbackFrom()?.model ?? null, keyHint: null, models: [], modelsFetchedAt: null, verifiedAt: null };
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

/** Cibles de la passerelle pour un agent de ce propriétaire (US-070). */
export async function resolveTargets(tenantId: string, agentId: AgentId | string): Promise<GatewayTarget[]> {
  return buildTargets({ primary: await resolveLlm(tenantId, agentId), openai: openaiFallbackFrom() });
}

/** Modèle effectif d'un agent pour l'affichage (null = mode déterministe). Pur : ne touche ni la base ni le réseau. */
export function effectiveModel(source: LlmStatus["source"], agentModel: string | undefined | null, defaultModel: string): string | null {
  if (source === "aucune") return null;
  return source === "utilisateur" ? agentModel || defaultModel : defaultModel;
}
