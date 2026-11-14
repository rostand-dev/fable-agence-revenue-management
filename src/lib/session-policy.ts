/** Politique d'expiration de session. Aucun import serveur : la logique pure est partagée avec le navigateur. */

export const DEFAULT_IDLE_MINUTES = 15;
/** Plancher : l'avertissement d'une minute doit tenir dans le délai. */
export const MIN_IDLE_MINUTES = 2;
/** L'avertissement apparaît ce délai avant la déconnexion. */
export const WARNING_MS = 60_000;
/** Pas de réécriture en base plus souvent que ça : l'échéance est repoussée par paliers. */
export const REFRESH_STEP_MS = 60_000;

/** Lit SESSION_IDLE_MINUTES (minutes, nombre entier ou décimal). Valeur absente, invalide ou < 2 : repli sur 15 min. Serveur uniquement, lu à chaque appel. */
export function idleMinutesFromEnv(raw: string | undefined = process.env.SESSION_IDLE_MINUTES): number {
  const n = Number(raw);
  return raw?.trim() && Number.isFinite(n) && n >= MIN_IDLE_MINUTES ? n : DEFAULT_IDLE_MINUTES;
}
export const idleMsFromEnv = (raw?: string): number => idleMinutesFromEnv(raw) * 60_000;

export function newExpiry(idleMs: number, now: number = Date.now()): Date {
  return new Date(now + idleMs);
}

export function isExpired(expiresAt: Date, now: number = Date.now()): boolean {
  return expiresAt.getTime() <= now;
}

/** Nouvelle échéance si la session mérite d'être prolongée, sinon null (évite une écriture à chaque requête). */
export function refreshedExpiry(expiresAt: Date, idleMs: number, now: number = Date.now()): Date | null {
  if (isExpired(expiresAt, now)) return null;
  const next = now + idleMs;
  return next - expiresAt.getTime() >= REFRESH_STEP_MS ? new Date(next) : null;
}
