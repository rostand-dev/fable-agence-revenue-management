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
export async function ensureDemoAccount(env: DemoAccountEnv = process.env): Promise<"created" | "exists" | "skipped"> {
  const d = demoAccountDecision(env);
  if (!d.run) {
    if (d.reason) console.warn("[compte démo]", d.reason);
    return "skipped";
  }
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, d.email));
  if (exists) return "exists";

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
  console.log("[compte démo] compte créé pour", d.email);
  return "created";
}
