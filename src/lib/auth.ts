import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db, ensureMigrated, schema } from "@/db";
import { forgetThisDevice } from "@/lib/remember";
import { idleMsFromEnv, isExpired, newExpiry, refreshedExpiry } from "@/lib/session-policy";

const COOKIE = "ns_session";

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${scryptSync(pw, salt, 64).toString("hex")}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const a = Buffer.from(hash, "hex"), b = scryptSync(pw, Buffer.from(salt, "hex"), 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `passwordVerified` : la personne vient de saisir son mot de passe (connexion, inscription). Faux pour une session rétablie par « Rester connecté » ou la démo. */
export async function createSession(userId: string, opts: { passwordVerified?: boolean } = {}): Promise<void> {
  // connexion par mot de passe : un jeton « Rester connecté » laissé par quelqu'un d'autre sur ce navigateur ne doit pas rouvrir sa session plus tard
  if (opts.passwordVerified) await forgetThisDevice();
  const id = randomBytes(32).toString("hex");
  const expiresAt = newExpiry(idleMsFromEnv());
  // ménage au passage : les sessions échues ne servent plus à rien
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  await db.insert(schema.sessions).values({ id, userId, expiresAt, passwordVerifiedAt: opts.passwordVerified ? new Date() : null });
  // cookie de session (sans date) : l'échéance qui fait foi est celle de la base, repoussée à chaque activité
  (await cookies()).set(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: (process.env.APP_URL ?? "").startsWith("https"), path: "/" });
}
export async function destroySession(): Promise<void> {
  const jar = await cookies(); const id = jar.get(COOKIE)?.value;
  if (id) await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  jar.delete(COOKIE);
}

/** `sessionId` et `passwordVerified` servent aux actions sensibles (clés API) : voir lib/reauth.ts. */
export type CurrentUser = { sessionId: string; passwordVerified: boolean; id: string; name: string; email: string; tenantId: string; tenantName: string; settings: Record<string, any> };

export const getUser = cache(async (): Promise<CurrentUser | null> => {
  await ensureMigrated();
  const id = (await cookies()).get(COOKIE)?.value;
  if (!id) return null;
  const rows = await db.select({ s: schema.sessions, u: schema.users, t: schema.tenants }).from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId)).innerJoin(schema.tenants, eq(schema.tenants.id, schema.users.tenantId))
    .where(eq(schema.sessions.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  if (isExpired(r.s.expiresAt)) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
    return null;
  }
  // expiration glissante : chaque requête authentifiée repousse l'échéance du délai d'inactivité (SESSION_IDLE_MINUTES, 15 min par défaut), par paliers d'une minute
  const next = refreshedExpiry(r.s.expiresAt, idleMsFromEnv());
  if (next) await db.update(schema.sessions).set({ expiresAt: next }).where(eq(schema.sessions.id, id));
  return { sessionId: id, passwordVerified: !!r.s.passwordVerifiedAt, id: r.u.id, name: r.u.name, email: r.u.email, tenantId: r.u.tenantId, tenantName: r.t.name, settings: r.t.settings ?? {} };
});
/** Toute page et toute action du cockpit passe par ici : l'isolation par propriétaire en dépend. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await getUser();
  // sans session : la route tente d'abord « Rester connecté », puis renvoie vers /connexion
  if (!u) redirect("/api/session/restore");
  return u;
}
