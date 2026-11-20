import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ensureMigrated } from "@/db";
import { createSession, getUser } from "@/lib/auth";
import { clientIp, rateKey } from "@/lib/password-reset";
import { allowAttempt } from "@/lib/rate-limit";
import { restoreFromRemember, readRememberCookie } from "@/lib/remember";
import { safeNext } from "@/lib/remember-policy";

export const dynamic = "force-dynamic";
/**
 * Rétablit la session d'un appareil « Rester connecté » (jeton rotatif), puis renvoie vers `next` (chemin interne uniquement).
 * Sans jeton valide : /connexion, avec `?expire=1` si le navigateur vient de perdre sa session par inactivité.
 * Les cookies ne s'écrivent pas pendant le rendu d'une page : c'est pour cela que cette étape est une route.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const failed = url.searchParams.get("expire") === "1" ? "/connexion?expire=1" : "/connexion";
  await ensureMigrated();
  if (await getUser()) redirect(next);
  if (!(await readRememberCookie())) redirect(failed);
  if (!(await allowAttempt("remember-restore", rateKey("ip", clientIp(await headers())), 300))) redirect(failed);
  const who = await restoreFromRemember();
  if (!who) redirect(failed);
  await createSession(who.userId); // session sans « mot de passe vérifié » : les clés API le redemanderont
  redirect(next);
}
