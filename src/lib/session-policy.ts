/** Politique d'expiration de session. Aucun import serveur : partagé avec le navigateur. */

/** Durée d'inactivité au bout de laquelle la connexion expire. */
export const IDLE_MINUTES = 15;
export const IDLE_MS = IDLE_MINUTES * 60_000;
/** L'avertissement apparaît ce délai avant la déconnexion. */
export const WARNING_MS = 60_000;
/** Pas de réécriture en base plus souvent que ça : l'échéance est repoussée par paliers. */
export const REFRESH_STEP_MS = 60_000;

export function newExpiry(now: number = Date.now()): Date {
  return new Date(now + IDLE_MS);
}

export function isExpired(expiresAt: Date, now: number = Date.now()): boolean {
  return expiresAt.getTime() <= now;
}

/** Nouvelle échéance si la session mérite d'être prolongée, sinon null (évite une écriture à chaque requête). */
export function refreshedExpiry(expiresAt: Date, now: number = Date.now()): Date | null {
  if (isExpired(expiresAt, now)) return null;
  const next = now + IDLE_MS;
  return next - expiresAt.getTime() >= REFRESH_STEP_MS ? new Date(next) : null;
}
