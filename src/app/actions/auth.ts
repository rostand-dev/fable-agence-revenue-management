"use server";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensureMigrated, newId, schema } from "@/db";
import { createSession, destroySession, hashPassword, verifyPassword } from "@/lib/auth";
import { seedDemo } from "@/lib/services/seed";

export type AuthState = { error?: string; values?: Record<string, string> };
const Sign = z.object({ name: z.string().trim().min(2, "Indiquez votre nom."), email: z.string().trim().toLowerCase().email("Adresse e-mail invalide."), password: z.string().min(10, "Le mot de passe doit compter au moins 10 caractères.") });

export async function signupAction(_: AuthState, fd: FormData): Promise<AuthState> {
  await ensureMigrated();
  const raw = { name: String(fd.get("name") ?? ""), email: String(fd.get("email") ?? ""), password: String(fd.get("password") ?? "") };
  const p = Sign.safeParse(raw);
  if (!p.success) return { error: p.error.issues[0].message, values: { name: raw.name, email: raw.email } };
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, p.data.email));
  if (exists) return { error: "Un compte existe déjà avec cette adresse. Connectez-vous.", values: { name: raw.name, email: raw.email } };
  const tenantId = newId("tn"), userId = newId("usr");
  await db.insert(schema.tenants).values({ id: tenantId, name: p.data.name });
  await db.insert(schema.users).values({ id: userId, tenantId, email: p.data.email, name: p.data.name, passwordHash: hashPassword(p.data.password) });
  await seedDemo(tenantId);
  await createSession(userId);
  redirect("/");
}

export async function loginAction(_: AuthState, fd: FormData): Promise<AuthState> {
  await ensureMigrated();
  const email = String(fd.get("email") ?? "").trim().toLowerCase(), password = String(fd.get("password") ?? "");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!u || !verifyPassword(password, u.passwordHash)) return { error: "Adresse ou mot de passe incorrect.", values: { email } };
  await createSession(u.id);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/connexion");
}
