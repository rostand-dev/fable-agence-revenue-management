import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { encryptSecret, secretHint } from "@/lib/secret";

export const TEST_OWNER_KEY = "sk-ant-proprietaire-de-test-0123456789";
const DEFAULT_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];

/** Clé du propriétaire pour un fournisseur (le serveur n'en détient aucune) : l'enregistre, ou la retire avec `null`. */
export async function setOwnerKey(tenantId: string, key: string | null = TEST_OWNER_KEY, provider: "anthropic" | "openai" | "mistral" = "anthropic", models: string[] = DEFAULT_MODELS) {
  process.env.APP_SECRET ||= "secret-de-test-assez-long-0123456789";
  if (key === null) { await db.delete(schema.llmCredentials).where(and(eq(schema.llmCredentials.tenantId, tenantId), eq(schema.llmCredentials.provider, provider))); return; }
  const now = new Date(), row = { apiKeyEnc: encryptSecret(key), keyHint: secretHint(key), models: models.map((id) => ({ id, name: id, createdAt: null })), modelsFetchedAt: now, verifiedAt: now, updatedAt: now };
  await db.insert(schema.llmCredentials).values({ tenantId, provider, ...row }).onConflictDoUpdate({ target: [schema.llmCredentials.tenantId, schema.llmCredentials.provider], set: row });
}
