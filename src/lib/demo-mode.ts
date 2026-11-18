/**
 * Instance de démonstration publique (DEMO_READONLY=true) : toute modification est refusée.
 * À ne définir que sur l'application Coolify de la démo, jamais sur la production ni sur le preview.
 */
const TRUE = /^\s*(true|1|on|yes|oui)\s*$/i;

export const demoReadonly = (raw: string | undefined = process.env.DEMO_READONLY): boolean => TRUE.test(raw ?? "");

/** URL http(s) valide, sinon null (variable absente, vide ou mal saisie : la fonctionnalité associée disparaît sans erreur). */
export function httpUrl(raw: string | undefined): string | null {
  try {
    const u = new URL((raw ?? "").trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch { return null; }
}
/** Production : adresse de la démo (bouton « Voir la démo » sur les pages de connexion). */
export const demoUrl = (raw: string | undefined = process.env.DEMO_URL): string | null => httpUrl(raw);
/** Démo : adresse de création de compte sur la production (bandeau et bouton « Quitter la démo »). */
export const demoSignupUrl = (raw: string | undefined = process.env.DEMO_SIGNUP_URL): string | null => httpUrl(raw);

/** Message affiché partout où une modification est refusée (verrou serveur, formulaires, parcours). */
export const DEMO_READONLY_MESSAGE = "Démo en lecture seule : cette action n'est pas disponible.";

/** Seuls ces appels peuvent modifier quelque chose en lecture seule : le suivi d'activité et la fin de session pour inactivité. */
const ALLOWED_WRITES = new Set(["/api/session/touch", "/api/session/end"]);

/** Verrou central : tout ce qui n'est pas une lecture est refusé, y compris les futures actions serveur (ce sont des POST). */
export function blockedInReadonly(method: string, pathname: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  return !ALLOWED_WRITES.has(pathname.replace(/\/+$/, "") || "/");
}
