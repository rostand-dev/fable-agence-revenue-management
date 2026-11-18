import { passwordProblem } from "./password-reset";

/** Variables lues par le compte de démo. Passées en paramètre pour rester testables. */
export type DemoAccountEnv = Record<string, string | undefined>;

export type DemoAccountDecision =
  | { run: true; email: string; password: string; name: string }
  | { run: false; reason: string | null }; // reason null = désactivé normalement, rien à signaler

const TRUE = /^\s*(true|1|on|yes|oui)\s*$/i;

/** Nom d'hôte de APP_URL, en minuscules, sans port. Chaîne vide si APP_URL est absente ou invalide. */
export function hostOf(appUrl: string | undefined): string {
  try { return new URL((appUrl ?? "").trim()).hostname.toLowerCase(); } catch { return ""; }
}

/**
 * Le domaine correspond-il au motif ? Motif exact (« preview.exemple.fr ») ou joker de tête (« *.exemple.fr »).
 * Le joker exige au moins un sous-domaine : « *.exemple.fr » ne couvre pas « exemple.fr » lui-même.
 * Tout autre usage de « * », un motif vide ou une valeur sans point (« disabled ») ne correspond jamais.
 */
export function hostMatches(host: string, pattern: string | undefined): boolean {
  const h = host.trim().toLowerCase(), p = (pattern ?? "").trim().toLowerCase();
  if (!h || !p || !p.includes(".")) return false;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // « .exemple.fr »
    if (suffix.includes("*") || suffix.length < 3) return false;
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  if (p.includes("*")) return false;
  return h === p;
}

/**
 * Décide si le compte de démo doit être créé. Trois conditions cumulées :
 * drapeau DEMO_ACCOUNT_ENABLED=true, domaine de APP_URL autorisé, mot de passe conforme.
 * Sans le drapeau, on s'arrête sans bruit et sans lire le reste (cas de la production).
 */
export function demoAccountDecision(env: DemoAccountEnv = process.env): DemoAccountDecision {
  if (!TRUE.test(env.DEMO_ACCOUNT_ENABLED ?? "")) return { run: false, reason: null };
  const host = hostOf(env.APP_URL);
  if (!hostMatches(host, env.DEMO_ACCOUNT_ALLOWED_HOST))
    return { run: false, reason: `domaine « ${host || "inconnu"} » non autorisé par DEMO_ACCOUNT_ALLOWED_HOST : compte de démo non créé` };
  const email = (env.DEMO_ACCOUNT_EMAIL ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { run: false, reason: "DEMO_ACCOUNT_EMAIL absent ou invalide : compte de démo non créé" };
  const password = env.DEMO_ACCOUNT_PASSWORD ?? "";
  const problem = passwordProblem(password, email);
  if (problem) return { run: false, reason: `DEMO_ACCOUNT_PASSWORD refusé (${problem}) : compte de démo non créé` };
  const name = (env.DEMO_ACCOUNT_NAME ?? "").trim() || "Compte démo";
  return { run: true, email, password, name };
}
