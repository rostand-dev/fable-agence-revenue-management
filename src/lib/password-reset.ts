import { createHash, createHmac, randomBytes } from "node:crypto";

/** Durée de validité d'un lien (PASSWORD_RESET_MINUTES, 30 par défaut, entre 5 et 120). */
export function resetMinutesFromEnv(raw: string | undefined = process.env.PASSWORD_RESET_MINUTES): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n >= 5 && n <= 120 ? n : 30;
}

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

/** Jeton aléatoire de 32 octets (base64url, 43 caractères). Seul son hash SHA-256 est enregistré. */
export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
/** Écarte sans requête tout ce qui ne peut pas être un de nos jetons. */
export const looksLikeToken = (t: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(t);

/** Clé de limitation de débit : empreinte HMAC, jamais l'adresse e-mail ou l'IP en clair. */
export function rateKey(kind: string, value: string): string {
  return createHmac("sha256", process.env.APP_SECRET || "nuitsignal-dev").update(kind + "\0" + value.trim().toLowerCase()).digest("hex");
}

/** Lien de réinitialisation construit avec APP_URL, jamais avec l'en-tête Host (injection d'en-tête). */
export function resetLink(token: string, appUrl: string | undefined = process.env.APP_URL): string {
  const base = (appUrl || "http://localhost:3000").replace(/\/+$/, "");
  return `${base}/reinitialisation/${token}`;
}

/** Règles du nouveau mot de passe, communes à l'inscription et à la réinitialisation. Retourne un message ou null. */
export function passwordProblem(pw: string, email?: string): string | null {
  if (pw.length < PASSWORD_MIN) return `Le mot de passe doit compter au moins ${PASSWORD_MIN} caractères.`;
  if (pw.length > PASSWORD_MAX) return `Le mot de passe ne peut pas dépasser ${PASSWORD_MAX} caractères.`;
  if (email && pw.trim().toLowerCase() === email.trim().toLowerCase()) return "Le mot de passe ne peut pas être votre adresse e-mail.";
  return null;
}

/**
 * Mot de passe déjà compromis ? API Have I Been Pwned en k-anonymité : seuls les 5 premiers caractères
 * du SHA-1 quittent le serveur. En cas d'indisponibilité on laisse passer (jamais de blocage à cause d'un tiers).
 */
export async function isPwned(pw: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    const sha = createHash("sha1").update(pw).digest("hex").toUpperCase();
    const prefix = sha.slice(0, 5), suffix = sha.slice(5);
    const res = await fetcher(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split("\n").some((l) => { const [h, c] = l.trim().split(":"); return h === suffix && Number(c) > 0; });
  } catch {
    return false;
  }
}

/** Durée minimale d'une réponse : la réponse ne dit pas si le compte existe. */
export async function padTo(startedAt: number, minMs: number): Promise<void> {
  const left = minMs - (Date.now() - startedAt);
  if (left > 0) await new Promise((r) => setTimeout(r, left));
}

/** IP du client : dernier saut ajouté par le proxy (Coolify/Traefik), plus difficile à falsifier que le premier. */
export function clientIp(h: { get(name: string): string | null }): string {
  const xff = h.get("x-forwarded-for");
  if (xff) { const parts = xff.split(",").map((s) => s.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
  return h.get("x-real-ip")?.trim() || "inconnue";
}
