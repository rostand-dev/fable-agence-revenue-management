/** Règles pures de « Rester connecté » (sans accès base ni cookies) : partagées et testables. */

export const DEFAULT_REMEMBER_DAYS = 30;
export const MAX_REMEMBER_DAYS = 90;
/** Deux requêtes (ou deux onglets) peuvent présenter le même jeton en même temps : au-delà de ce délai, un jeton déjà utilisé est un rejeu. */
export const REUSE_GRACE_MS = 10_000;

/** REMEMBER_ME_DAYS : 0 désactive la fonction ; entier de 1 à 90 sinon ; absent ou invalide = 30. */
export function rememberDaysFromEnv(raw: string | undefined = process.env.REMEMBER_ME_DAYS): number {
  if (raw === undefined || !raw.trim()) return DEFAULT_REMEMBER_DAYS;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 && n <= MAX_REMEMBER_DAYS ? n : DEFAULT_REMEMBER_DAYS;
}

export type TokenVerdict = "expired" | "rotate" | "grace" | "reuse";
/**
 * - expired : échéance dépassée.
 * - rotate  : jeton jamais utilisé, on le remplace par un nouveau.
 * - grace   : utilisé il y a quelques secondes (requête simultanée) : on ouvre la session sans nouveau jeton.
 * - reuse   : utilisé plus tôt, donc probablement copié : toute la famille est révoquée.
 */
export function judgeToken(row: { expiresAt: Date; usedAt: Date | null }, now: number = Date.now()): TokenVerdict {
  if (row.expiresAt.getTime() <= now) return "expired";
  if (!row.usedAt) return "rotate";
  return now - row.usedAt.getTime() <= REUSE_GRACE_MS ? "grace" : "reuse";
}

/** Destination après restauration : uniquement un chemin interne (jamais d'adresse externe ni de `//`). */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || raw.length > 512) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f\u007f]/.test(raw)) return "/";
  // pas de retour vers les routes techniques de session (boucle)
  if (raw.startsWith("/api/")) return "/";
  return raw;
}
