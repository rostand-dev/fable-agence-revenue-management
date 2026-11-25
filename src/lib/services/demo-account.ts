import { encryptSecret, secretHint } from "../secret";
import { eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { hashPassword } from "@/lib/auth";
import { demoAccountDecision, type DemoAccountEnv } from "@/lib/demo-account-config";
import { seedDemo } from "./seed";

class AlreadyThere extends Error {}

/**
 * Environnements de test/preview : crée un compte propriétaire prêt à l'emploi (avec les logements de démonstration).
 * Idempotent : si l'adresse existe déjà, rien n'est modifié (ni mot de passe, ni données). Jamais bloquant pour le démarrage.
 */
/** Clé de modèle factice du compte de démo (tests/CI) : acceptée seulement si ANTHROPIC_API_BASE pointe vers cette machine (faux serveur de modèle). Partout ailleurs, ignorée. Pur. */
export function demoLlmKeyDecision(env: DemoAccountEnv = process.env): string | null {
  const key = env.DEMO_ACCOUNT_LLM_KEY?.trim();
  if (!key) return null;
  try { const u = new URL(env.ANTHROPIC_API_BASE ?? ""); return u.hostname === "127.0.0.1" || u.hostname === "localhost" ? key : null; } catch { return null; }
}

/** Enregistre la clé factice comme clé Anthropic du propriétaire du compte de démo (idempotent). Aucun appel réseau : la liste de modèles est celle du faux serveur. */
async function seedDemoLlmKey(tenantId: string, env: DemoAccountEnv) {
  const key = demoLlmKeyDecision(env);
  if (!key) return;
  const now = new Date(), models = ["claude-haiku-5-5", "claude-sonnet-5-5"].map((id) => ({ id, name: id, createdAt: null }));
  const row = { apiKeyEnc: encryptSecret(key), keyHint: secretHint(key), models, modelsFetchedAt: now, verifiedAt: now, updatedAt: now };
  await db.insert(schema.llmCredentials).values({ tenantId, provider: "anthropic", ...row }).onConflictDoUpdate({ target: [schema.llmCredentials.tenantId, schema.llmCredentials.provider], set: row });
}

export async function ensureDemoAccount(env: DemoAccountEnv = process.env): Promise<"created" | "exists" | "skipped"> {
  const d = demoAccountDecision(env);
  if (!d.run) {
    if (d.reason) console.warn("[compte démo]", d.reason);
    return "skipped";
  }
  const [exists] = await db.select({ id: schema.users.id, tenantId: schema.users.tenantId }).from(schema.users).where(eq(schema.users.email, d.email));
  if (exists) { await seedDemoLlmKey(exists.tenantId, env); return "exists"; }

  const tenantId = newId("tn"), userId = newId("usr");
  const created = await db.transaction(async (tx) => {
    await tx.insert(schema.tenants).values({ id: tenantId, name: d.name });
    // l'e-mail est unique : un démarrage concurrent qui insérerait en même temps ne provoque pas d'erreur
    const rows = await tx.insert(schema.users).values({ id: userId, tenantId, email: d.email, name: d.name, passwordHash: hashPassword(d.password) })
      .onConflictDoNothing({ target: schema.users.email }).returning({ id: schema.users.id });
    if (rows.length !== 1) throw new AlreadyThere(); // annule aussi la création du tenant
    return true;
  }).catch((e) => { if (e instanceof AlreadyThere) return false; throw e; });
  if (!created) return "exists";

  await seedDemo(tenantId);
  await seedDemoLlmKey(tenantId, env);
  console.log("[compte démo] compte créé pour", d.email);
  return "created";
}
