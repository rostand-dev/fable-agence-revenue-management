/**
 * Clés de modèles DU PROPRIÉTAIRE, une par fournisseur (Anthropic, OpenAI, Mistral). Le serveur n'en détient aucune :
 * c'est la seule source de clés pour l'application. Les clés sont chiffrées en base (APP_SECRET) et ne quittent jamais le serveur.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { decryptSecret } from "../secret";
import { LlmError, listAnthropicModels, type LlmModelInfo } from "./llm";
import type { ProviderKey } from "../llm-registry/catalog";

export const PROVIDER_KEYS: readonly ProviderKey[] = ["anthropic", "openai", "mistral"];
export const PROVIDER_LABEL: Record<ProviderKey, string> = { anthropic: "Anthropic", openai: "OpenAI", mistral: "Mistral" };
export const isProviderKey = (v: unknown): v is ProviderKey => typeof v === "string" && (PROVIDER_KEYS as readonly string[]).includes(v);

const compatBase = (p: "openai" | "mistral") => p === "openai" ? (process.env.OPENAI_API_BASE || "https://api.openai.com").replace(/\/$/, "") : (process.env.MISTRAL_API_BASE || "https://api.mistral.ai").replace(/\/$/, "");

/** Modèles que cette clé peut réellement utiliser (GET /v1/models). Erreurs en français, sans jamais citer la clé. Appel serveur uniquement. */
export async function listProviderModels(provider: ProviderKey, apiKey: string): Promise<LlmModelInfo[]> {
  if (provider === "anthropic") return listAnthropicModels(apiKey);
  const label = PROVIDER_LABEL[provider], ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
  let res: Response;
  try {
    // aucune redirection suivie : une clé API ne part jamais vers une autre adresse
    res = await fetch(compatBase(provider) + "/v1/models", { headers: { authorization: "Bearer " + apiKey, accept: "application/json" }, signal: ctrl.signal, cache: "no-store", redirect: "error" });
  } catch (e: any) {
    throw new LlmError(e?.name === "AbortError" ? `${label} n'a pas répondu à temps.` : `${label} est injoignable depuis le serveur.`);
  } finally { clearTimeout(timer); }
  if (res.status === 401) throw new LlmError(`Clé API refusée par ${label}. Vérifiez qu'elle est copiée en entier et qu'elle est active.`, 401);
  if (res.status === 403) throw new LlmError(`Accès refusé par ${label} : cette clé n'a pas le droit de lister les modèles.`, 403);
  if (res.status === 429) throw new LlmError(`Trop de requêtes vers ${label}. Réessayez dans quelques minutes.`, 429);
  if (!res.ok) throw new LlmError(`${label} a répondu par une erreur (HTTP ${res.status}).`, res.status);
  let data: any;
  try { data = await res.json(); } catch { throw new LlmError(`Réponse ${label} illisible.`); }
  const out: LlmModelInfo[] = [];
  for (const m of Array.isArray(data?.data) ? data.data : []) {
    if (!m || typeof m.id !== "string") continue;
    const created = typeof m.created === "number" ? new Date(m.created * 1000).toISOString() : typeof m.created_at === "string" ? m.created_at : null;
    out.push({ id: m.id, name: m.id, createdAt: created });
  }
  return out;
}

export type OwnerKey = { provider: ProviderKey; apiKey: string; keyHint: string; models: LlmModelInfo[]; modelsFetchedAt: Date | null; verifiedAt: Date | null };

/** Clés déchiffrées du propriétaire, par fournisseur. Une clé illisible (APP_SECRET changé) est ignorée : le fournisseur n'est alors pas utilisable. */
export async function loadOwnerKeys(tenantId: string): Promise<Map<ProviderKey, OwnerKey>> {
  const rows = await db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, tenantId));
  const out = new Map<ProviderKey, OwnerKey>();
  for (const c of rows) {
    if (!isProviderKey(c.provider)) continue;
    try { out.set(c.provider, { provider: c.provider, apiKey: decryptSecret(c.apiKeyEnc), keyHint: c.keyHint, models: c.models, modelsFetchedAt: c.modelsFetchedAt, verifiedAt: c.verifiedAt }); } catch { /* clé illisible : ignorée */ }
  }
  return out;
}
