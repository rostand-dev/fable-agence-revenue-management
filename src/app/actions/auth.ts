"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db, ensureMigrated, newId, schema } from "@/db";
import { createSession, destroySession, hashPassword, verifyPassword } from "@/lib/auth";
import { clientIp, generateToken, hashToken, isPwned, looksLikeToken, padTo, passwordProblem, rateKey, resetLink, resetMinutesFromEnv } from "@/lib/password-reset";
import { allowAttempt, purgeOldAttempts } from "@/lib/rate-limit";
import { emailConfigured, sendEmail } from "@/lib/email/resend";
import { SIGNUP_CONFIRM_MINUTES, signupConfirmationEnabled } from "@/lib/signup";
import { confirmSignupEmail } from "@/lib/email/templates/confirm-signup";
import { accountExistsEmail } from "@/lib/email/templates/account-exists";
import { resetPasswordEmail } from "@/lib/email/templates/reset-password";
import { passwordChangedEmail } from "@/lib/email/templates/password-changed";

export type AuthState = { error?: string; ok?: string; values?: Record<string, string> };
const Sign = z.object({ name: z.string().trim().min(2, "Indiquez votre nom."), email: z.string().trim().toLowerCase().email("Adresse e-mail invalide."), password: z.string().min(10, "Le mot de passe doit compter au moins 10 caractères.") });

export async function signupAction(_: AuthState, fd: FormData): Promise<AuthState> {
  const started = Date.now();
  await ensureMigrated();
  const raw = { name: String(fd.get("name") ?? ""), email: String(fd.get("email") ?? ""), password: String(fd.get("password") ?? "") };
  const p = Sign.safeParse(raw);
  if (!p.success) return { error: p.error.issues[0].message, values: { name: raw.name, email: raw.email } };
  const problem = passwordProblem(p.data.password, p.data.email);
  if (problem) return { error: problem, values: { name: raw.name, email: raw.email } };

  if (!signupConfirmationEnabled()) {
    // Mode sans confirmation (preview) : compte créé tout de suite. Ce mode révèle les adresses déjà inscrites.
    const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, p.data.email));
    if (exists) return { error: "Un compte existe déjà avec cette adresse. Connectez-vous.", values: { name: raw.name, email: raw.email } };
    const tenantId = newId("tn"), userId = newId("usr");
    await db.insert(schema.tenants).values({ id: tenantId, name: p.data.name });
    await db.insert(schema.users).values({ id: userId, tenantId, email: p.data.email, name: p.data.name, passwordHash: hashPassword(p.data.password) });
    await createSession(userId);
    redirect("/");
  }

  if (process.env.NODE_ENV === "production" && !emailConfigured()) {
    console.error("[inscription] confirmation par e-mail activée mais RESEND_API_KEY/EMAIL_FROM absents : inscription impossible");
    return { error: "L'inscription est momentanément indisponible. Réessayez plus tard.", values: { name: raw.name, email: raw.email } };
  }
  // Réponse identique pour une adresse nouvelle ou déjà inscrite, durée minimale fixe : rien ne révèle l'existence d'un compte.
  const done: AuthState = { ok: `Un e-mail vient d'être envoyé à ${p.data.email}. Cliquez sur le lien qu'il contient (valable ${SIGNUP_CONFIRM_MINUTES / 60} heure) pour activer votre espace.`, values: { email: p.data.email } };
  const ip = clientIp(await headers());
  const byIp = await allowAttempt("signup-ip", rateKey("ip", ip), 10);
  const byMail = await allowAttempt("signup-email", rateKey("email", p.data.email), 3);
  if (byIp && byMail) {
    const [u] = await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.email, p.data.email));
    if (u) {
      void sendEmail({ to: p.data.email, ...accountExistsEmail({ appUrl: appUrl(), name: u.name.split(" ")[0] }) });
    } else {
      const { token, hash } = generateToken();
      await db.transaction(async (tx) => {
        await tx.delete(schema.signupConfirmations).where(and(eq(schema.signupConfirmations.email, p.data.email), isNull(schema.signupConfirmations.usedAt)));
        await tx.insert(schema.signupConfirmations).values({ id: newId("sgc"), email: p.data.email, name: p.data.name, passwordHash: hashPassword(p.data.password), tokenHash: hash, expiresAt: new Date(Date.now() + SIGNUP_CONFIRM_MINUTES * 60_000) });
      });
      const link = `${appUrl()}/confirmation/${token}`;
      void sendEmail({ to: p.data.email, ...confirmSignupEmail({ link, minutes: SIGNUP_CONFIRM_MINUTES, appUrl: appUrl(), name: p.data.name.split(" ")[0] }), idempotencyKey: `signup-${hash.slice(0, 32)}` });
    }
  }
  await padTo(started, 900);
  return done;
}

export type ConfirmState = { error?: string; invalidLink?: boolean };

/** Clic sur le lien de confirmation : le compte est créé ici, et seulement ici. Jeton consommé de façon atomique. */
export async function confirmSignupAction(_: ConfirmState, fd: FormData): Promise<ConfirmState> {
  await ensureMigrated();
  const token = String(fd.get("token") ?? "");
  const ip = clientIp(await headers());
  if (!(await allowAttempt("signup-confirm-ip", rateKey("ip", ip), 10))) return { error: "Trop de tentatives. Réessayez dans une heure." };
  if (!looksLikeToken(token)) return { error: BAD_SIGNUP_LINK, invalidLink: true };
  const tenantId = newId("tn"), userId = newId("usr");
  const created = await db.transaction(async (tx) => {
    const used = await tx.update(schema.signupConfirmations).set({ usedAt: new Date() })
      .where(and(eq(schema.signupConfirmations.tokenHash, hashToken(token)), isNull(schema.signupConfirmations.usedAt), gt(schema.signupConfirmations.expiresAt, sql`now()`)))
      .returning();
    if (used.length !== 1) return false;
    const c = used[0];
    const [taken] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, c.email));
    if (taken) return false;
    await tx.insert(schema.tenants).values({ id: tenantId, name: c.name });
    await tx.insert(schema.users).values({ id: userId, tenantId, email: c.email, name: c.name, passwordHash: c.passwordHash });
    return true;
  });
  if (!created) return { error: BAD_SIGNUP_LINK, invalidLink: true };
  await createSession(userId);
  redirect("/");
}
const BAD_SIGNUP_LINK = "Ce lien n'est plus valable : il a expiré, a déjà été utilisé ou est incorrect. Recommencez votre inscription.";

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

const appUrl = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
const NEUTRAL = "Si un compte existe pour cette adresse, un e-mail vient d'être envoyé. Le lien est valable " ;

/**
 * Demande de lien. La réponse est identique que le compte existe ou non, et dure au moins 900 ms :
 * rien ne permet de deviner quelles adresses ont un compte. L'envoi d'e-mail ne bloque pas la réponse.
 */
export async function requestPasswordResetAction(_: AuthState, fd: FormData): Promise<AuthState> {
  const started = Date.now();
  await ensureMigrated();
  const raw = String(fd.get("email") ?? "");
  const p = z.string().trim().toLowerCase().max(254).email("Adresse e-mail invalide.").safeParse(raw);
  if (!p.success) return { error: p.error.issues[0].message, values: { email: raw.slice(0, 254) } };
  const email = p.data, minutes = resetMinutesFromEnv();
  const done: AuthState = { ok: NEUTRAL + minutes + " minutes.", values: { email } };

  const ip = clientIp(await headers());
  // les deux compteurs sont toujours incrémentés : un acharnement ne se débloque pas de lui-même
  const byIp = await allowAttempt("reset-request-ip", rateKey("ip", ip), 10);
  const byMail = await allowAttempt("reset-request-email", rateKey("email", email), 3);
  if (byIp && byMail) {
    const [u] = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.email, email));
    if (u) {
      const { token, hash } = generateToken();
      // un seul lien actif par utilisateur : une nouvelle demande invalide les précédentes
      await db.transaction(async (tx) => {
        await tx.delete(schema.passwordResets).where(and(eq(schema.passwordResets.userId, u.id), isNull(schema.passwordResets.usedAt)));
        await tx.insert(schema.passwordResets).values({ id: newId("pwr"), userId: u.id, tokenHash: hash, expiresAt: new Date(Date.now() + minutes * 60_000) });
      });
      const mail = resetPasswordEmail({ link: resetLink(token), minutes, appUrl: appUrl(), name: u.name.split(" ")[0] });
      void sendEmail({ to: email, ...mail, idempotencyKey: `pwreset-${hash.slice(0, 32)}` });
    }
  }
  if (Math.random() < 0.05) void purgeOldAttempts().catch(() => {});
  await padTo(started, 900);
  return done;
}

const BAD_LINK = "Ce lien n'est plus valable : il a expiré, a déjà été utilisé ou est incorrect. Demandez-en un nouveau.";

export type ResetState = { error?: string; invalidLink?: boolean };

/** Choix du nouveau mot de passe. Le jeton est consommé de façon atomique ; toutes les sessions sont fermées. */
export async function resetPasswordAction(_: ResetState, fd: FormData): Promise<ResetState> {
  await ensureMigrated();
  const token = String(fd.get("token") ?? ""), password = String(fd.get("password") ?? ""), confirm = String(fd.get("confirm") ?? "");
  const ip = clientIp(await headers());
  if (!(await allowAttempt("reset-submit-ip", rateKey("ip", ip), 10))) return { error: "Trop de tentatives. Réessayez dans une heure." };
  if (!looksLikeToken(token)) return { error: BAD_LINK, invalidLink: true };
  const hash = hashToken(token);

  // le lien est contrôlé avant le mot de passe, sans le consommer : une saisie refusée n'oblige pas à redemander un lien
  const [live] = await db.select({ userId: schema.passwordResets.userId }).from(schema.passwordResets)
    .where(and(eq(schema.passwordResets.tokenHash, hash), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, new Date())));
  if (!live) return { error: BAD_LINK, invalidLink: true };
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, live.userId));
  if (!user) return { error: BAD_LINK, invalidLink: true };

  const problem = passwordProblem(password, user.email);
  if (problem) return { error: problem };
  if (password !== confirm) return { error: "Les deux mots de passe ne sont pas identiques." };
  if (verifyPassword(password, user.passwordHash)) return { error: "Choisissez un mot de passe différent de l'ancien." };
  if (await isPwned(password)) return { error: "Ce mot de passe figure dans des fuites de données connues. Choisissez-en un autre." };

  const newHash = hashPassword(password);
  const ok = await db.transaction(async (tx) => {
    // consommation atomique : une seule requête peut réussir, même si deux arrivent en même temps
    const used = await tx.update(schema.passwordResets).set({ usedAt: new Date() })
      .where(and(eq(schema.passwordResets.tokenHash, hash), isNull(schema.passwordResets.usedAt), gt(schema.passwordResets.expiresAt, sql`now()`)))
      .returning({ userId: schema.passwordResets.userId });
    if (used.length !== 1) return false;
    await tx.update(schema.users).set({ passwordHash: newHash }).where(eq(schema.users.id, used[0].userId));
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, used[0].userId));
    await tx.delete(schema.passwordResets).where(and(eq(schema.passwordResets.userId, used[0].userId), ne(schema.passwordResets.tokenHash, hash)));
    return true;
  });
  if (!ok) return { error: BAD_LINK, invalidLink: true };

  const when = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" });
  void sendEmail({ to: user.email, ...passwordChangedEmail({ appUrl: appUrl(), when, name: user.name.split(" ")[0] }) });
  redirect("/connexion?reinit=1");
}
