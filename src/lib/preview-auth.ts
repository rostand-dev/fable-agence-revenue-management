/**
 * Protection par mot de passe (HTTP Basic) des environnements de Preview.
 * Active uniquement si PREVIEW_BASIC_AUTH_USER ou PREVIEW_BASIC_AUTH_PASSWORD est défini : à poser dans les variables « Preview Deployment »
 * de Coolify (jamais dans celles de la production, de la démo ni du staging). Sans ces variables, rien ne change.
 * Fonctions pures et portables (Node.js et Edge, sans Buffer) : appelées par le proxy (src/proxy.ts, exécuté par Node.js depuis Next 16), elles restent testables.
 */
export type PreviewAuthEnv = Record<string, string | undefined>;

export type PreviewAuthConfig =
  | { state: "off" }
  | { state: "invalid"; reason: string } // configuration incomplète ou trop faible : l'accès est refusé (jamais ouvert par erreur)
  | { state: "on"; user: string; password: string };

/** Longueur minimale du mot de passe de la Preview (elle est publique sur Internet). */
export const PREVIEW_PASSWORD_MIN = 12;

/** Seule route toujours accessible sans mot de passe : le contrôle de santé (Docker, Coolify, CI), qui ne renvoie rien de sensible. */
export const PREVIEW_PUBLIC_PATHS = ["/api/health"];

export function previewAuthConfig(env: PreviewAuthEnv = process.env): PreviewAuthConfig {
  const user = (env.PREVIEW_BASIC_AUTH_USER ?? "").trim(), password = env.PREVIEW_BASIC_AUTH_PASSWORD ?? "";
  if (!user && !password) return { state: "off" };
  if (!user) return { state: "invalid", reason: "PREVIEW_BASIC_AUTH_USER manquant" };
  if (user.includes(":")) return { state: "invalid", reason: "PREVIEW_BASIC_AUTH_USER ne doit pas contenir « : »" };
  if (password.length < PREVIEW_PASSWORD_MIN) return { state: "invalid", reason: `PREVIEW_BASIC_AUTH_PASSWORD trop court (${PREVIEW_PASSWORD_MIN} caractères au moins)` };
  return { state: "on", user, password };
}

export const isPreviewPublicPath = (pathname: string): boolean => PREVIEW_PUBLIC_PATHS.includes(pathname.replace(/\/+$/, "") || "/");

/** Comparaison en temps constant (la durée ne dépend pas de la position de la première différence). */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** L'en-tête Authorization contient-il les bons identifiants ? Format attendu : « Basic base64(utilisateur:mot de passe) ». */
export function basicAuthOk(header: string | null | undefined, cfg: Extract<PreviewAuthConfig, { state: "on" }>): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (!m) return false;
  let decoded: string;
  try { decoded = new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return false; }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const okUser = safeEqual(decoded.slice(0, i), cfg.user), okPass = safeEqual(decoded.slice(i + 1), cfg.password);
  return okUser && okPass;
}

/** Décision pour une requête : laisser passer, demander les identifiants (401) ou refuser (503, configuration invalide). */
export function previewAuthDecision(pathname: string, authorization: string | null | undefined, env: PreviewAuthEnv = process.env): "allow" | "challenge" | "misconfigured" {
  const cfg = previewAuthConfig(env);
  if (cfg.state === "off" || isPreviewPublicPath(pathname)) return "allow";
  if (cfg.state === "invalid") return "misconfigured";
  return basicAuthOk(authorization, cfg) ? "allow" : "challenge";
}
