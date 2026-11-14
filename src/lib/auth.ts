import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db, ensureMigrated, schema } from "@/db";
import { isExpired, newExpiry, refreshedExpiry } from "@/lib/session-policy";

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

export async function createSession(userId: string): Promise<void> {
  const id = randomBytes(32).toString("hex");
  const expiresAt = newExpiry();
  // ménage au passage : les sessions échues ne servent plus à rien
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, new Date()));
  await db.insert(schema.sessions).values({ id, userId, expiresAt });
  // cookie de session (sans date) : l'échéance qui fait foi est celle de la base, repoussée à chaque activité
  (await cookies()).set(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: (process.env.APP_URL ?? "").startsWith("https"), path: "/" });
}
export async function destroySession(): Promise<void> {
  const jar = await cookies(); const id = jar.get(COOKIE)?.value;
  if (id) await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  jar.delete(COOKIE);
}

export type CurrentUser = { id: string; name: string; email: string; tenantId: string; tenantName: string; settings: Record<string, any> };

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
  // expiration glissante : chaque requête authentifiée repousse l'échéance de 15 min (par paliers d'une minute)
  const next = refreshedExpiry(r.s.expiresAt);
  if (next) await db.update(schema.sessions).set({ expiresAt: next }).where(eq(schema.sessions.id, id));
  return { id: r.u.id, name: r.u.name, email: r.u.email, tenantId: r.u.tenantId, tenantName: r.t.name, settings: r.t.settings ?? {} };
});
/** Toute page et toute action du cockpit passe par ici : l'isolation par propriétaire en dépend. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await getUser();
  if (!u) redirect("/connexion");
  return u;
}
