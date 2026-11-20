import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { verifyPassword, type CurrentUser } from "@/lib/auth";
import { rateKey } from "@/lib/password-reset";
import { allowAttempt } from "@/lib/rate-limit";

export type ReauthRefusal = { error: string; reauth: true };
export const REAUTH_FIELD = "confirmPassword";

/**
 * Garde des actions sensibles (enregistrer, remplacer ou retirer une clé API).
 * Une session ouverte par mot de passe passe tout de suite. Une session rétablie par « Rester connecté » doit d'abord
 * recevoir le mot de passe (champ `confirmPassword`) ; une fois vérifié, elle est marquée et ne le redemande plus.
 * Retourne null si l'action peut continuer, sinon le refus à renvoyer au formulaire.
 */
export async function confirmPasswordIfNeeded(u: CurrentUser, fd: FormData): Promise<ReauthRefusal | null> {
  if (u.passwordVerified) return null;
  const pw = String(fd.get(REAUTH_FIELD) ?? "");
  if (!pw) return { error: "Pour modifier une clé API, confirmez votre mot de passe.", reauth: true };
  if (!(await allowAttempt("reauth-user", rateKey("user", u.id), 10)))
    return { error: "Trop de tentatives. Réessayez dans une heure.", reauth: true };
  const [row] = await db.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, u.id));
  if (!row || !verifyPassword(pw, row.hash)) return { error: "Mot de passe incorrect.", reauth: true };
  await db.update(schema.sessions).set({ passwordVerifiedAt: new Date() }).where(eq(schema.sessions.id, u.sessionId));
  return null;
}
