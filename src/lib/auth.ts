import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, ensureMigrated, schema } from "@/db";

const COOKIE = "ns_session";
const DAYS = 30;

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
  const expiresAt = new Date(Date.now() + DAYS * 86400000);
  await db.insert(schema.sessions).values({ id, userId, expiresAt });
  (await cookies()).set(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: (process.env.APP_URL ?? "").startsWith("https"), path: "/", expires: expiresAt });
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
  if (!r || r.s.expiresAt < new Date()) return null;
  return { id: r.u.id, name: r.u.name, email: r.u.email, tenantId: r.u.tenantId, tenantName: r.t.name, settings: r.t.settings ?? {} };
});
/** Toute page et toute action du cockpit passe par ici : l'isolation par propriétaire en dépend. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await getUser();
  if (!u) redirect("/connexion");
  return u;
}
