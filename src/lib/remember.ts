import { cookies } from "next/headers";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { generateToken, hashToken, looksLikeToken } from "@/lib/password-reset";
import { judgeToken, rememberDaysFromEnv } from "@/lib/remember-policy";

export const REMEMBER_COOKIE = "ns_remember";
/** Chemin « / » : la déconnexion volontaire est une action serveur sur une page, elle doit recevoir le cookie pour révoquer le jeton en base. Le cookie reste httpOnly. */
const COOKIE_PATH = "/";
const DAY = 86_400_000;

const secure = () => (process.env.APP_URL ?? "").startsWith("https");
async function setCookie(token: string, days: number) {
  (await cookies()).set(REMEMBER_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: secure(), path: COOKIE_PATH, maxAge: days * 86400 });
}
export async function clearRememberCookie() { (await cookies()).delete({ name: REMEMBER_COOKIE, path: COOKIE_PATH }); }
export async function readRememberCookie(): Promise<string | null> {
  const v = (await cookies()).get(REMEMBER_COOKIE)?.value ?? "";
  return looksLikeToken(v) ? v : null;
}

/** Ménage au passage : jetons échus, et jetons utilisés depuis plus d'une journée (déjà remplacés, sans intérêt pour la détection de rejeu une fois échus). */
async function purge() {
  await db.delete(schema.rememberTokens).where(or(lt(schema.rememberTokens.expiresAt, new Date()), and(isNotNull(schema.rememberTokens.usedAt), lt(schema.rememberTokens.usedAt, new Date(Date.now() - DAY)))));
}

async function insertToken(userId: string, familyId: string, days: number): Promise<string> {
  const { token, hash } = generateToken();
  await db.insert(schema.rememberTokens).values({ id: newId("rmb"), userId, familyId, tokenHash: hash, expiresAt: new Date(Date.now() + days * DAY) });
  return token;
}

/** Nouvel appareil : à la connexion par mot de passe, case « Rester connecté » cochée. No-op si la fonction est désactivée (REMEMBER_ME_DAYS=0). */
export async function issueRememberToken(userId: string): Promise<void> {
  const days = rememberDaysFromEnv();
  if (days <= 0) return;
  await purge();
  await setCookie(await insertToken(userId, newId("fam"), days), days);
}

export type Restored = { userId: string } | null;
/**
 * Échange le jeton du cookie contre une identité. Remplace le jeton (rotation) ; révoque la famille si un jeton déjà utilisé est rejoué.
 * À appeler depuis une route (les cookies ne s'écrivent pas pendant le rendu d'une page).
 */
export async function restoreFromRemember(): Promise<Restored> {
  const days = rememberDaysFromEnv();
  const token = await readRememberCookie();
  if (days <= 0 || !token) { if (token) await clearRememberCookie(); return null; }
  const [row] = await db.select().from(schema.rememberTokens).where(eq(schema.rememberTokens.tokenHash, hashToken(token)));
  if (!row) { await clearRememberCookie(); return null; }
  const verdict = judgeToken(row);
  if (verdict === "reuse") { await db.delete(schema.rememberTokens).where(eq(schema.rememberTokens.familyId, row.familyId)); await clearRememberCookie(); return null; }
  if (verdict === "expired") { await db.delete(schema.rememberTokens).where(eq(schema.rememberTokens.id, row.id)); await clearRememberCookie(); return null; }
  if (verdict === "grace") return { userId: row.userId }; // le cookie à jour vient de la requête concurrente
  // consommation atomique : si deux requêtes arrivent en même temps, une seule fait la rotation
  const taken = await db.update(schema.rememberTokens).set({ usedAt: new Date() })
    .where(and(eq(schema.rememberTokens.id, row.id), isNull(schema.rememberTokens.usedAt))).returning({ id: schema.rememberTokens.id });
  if (taken.length === 1) await setCookie(await insertToken(row.userId, row.familyId, days), days);
  return { userId: row.userId };
}

/** Déconnexion volontaire : cet appareil n'est plus reconnu. */
export async function forgetThisDevice(): Promise<void> {
  const token = await readRememberCookie();
  if (token) {
    const [row] = await db.select({ familyId: schema.rememberTokens.familyId }).from(schema.rememberTokens).where(eq(schema.rememberTokens.tokenHash, hashToken(token)));
    if (row) await db.delete(schema.rememberTokens).where(eq(schema.rememberTokens.familyId, row.familyId));
  }
  await clearRememberCookie();
}

/** « Se déconnecter partout » et changement de mot de passe : plus aucun appareil n'est reconnu. */
export async function forgetAllDevices(userId: string): Promise<void> {
  await db.delete(schema.rememberTokens).where(eq(schema.rememberTokens.userId, userId));
}
