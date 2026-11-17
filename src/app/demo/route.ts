import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, ensureMigrated, schema } from "@/db";
import { createSession, getUser } from "@/lib/auth";
import { demoAccountDecision } from "@/lib/demo-account-config";
import { demoReadonly } from "@/lib/demo-mode";
import { clientIp, rateKey } from "@/lib/password-reset";
import { allowAttempt } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Entrée de la démo publique : ouvre la session du compte de démo sans mot de passe.
 * N'existe que si DEMO_READONLY=true ET que le compte de démo est autorisé sur ce domaine (mêmes garde-fous que le seed) :
 * partout ailleurs, y compris en production, la page est introuvable.
 */
export async function GET() {
  const d = demoAccountDecision();
  if (!demoReadonly() || !d.run) return new Response("Introuvable", { status: 404 });
  await ensureMigrated();
  if (await getUser()) redirect("/");
  if (!(await allowAttempt("demo-entry", rateKey("ip", clientIp(await headers())), 60)))
    return new Response("Trop de visites depuis cette adresse. Réessayez dans une heure.", { status: 429, headers: { "Retry-After": "3600" } });
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, d.email));
  if (!u) return new Response("La démo se prépare. Réessayez dans un instant.", { status: 503, headers: { "Retry-After": "10" } });
  await createSession(u.id);
  redirect("/");
}
