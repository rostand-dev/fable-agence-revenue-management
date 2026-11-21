/**
 * Données personnelles (US-034, blueprint §16.2 et §16.3) : masquage dans les journaux et dans ce qui part vers un LLM.
 *
 * Principe : le revenue management n'a pas besoin de l'identité du voyageur. Trois barrières, de la plus forte à la plus tardive :
 *  1. MINIMISATION à l'entrée : ce qui est lu chez SuperHote passe par une liste blanche de champs (`pickAllowed`) ; l'identité du voyageur n'est jamais stockée.
 *  2. PASSERELLE LLM : tout texte envoyé à un modèle est masqué (`maskPii`) avant l'appel.
 *  3. JOURNAUX : `console.*` est enveloppé au démarrage du serveur (`installLogMasking`) : e-mails, téléphones, IBAN, cartes et secrets n'y apparaissent pas.
 *
 * Module pur (aucun accès base, aucun import de l'application) : partagé par le serveur, les tests et le journal d'audit.
 * Un masquage se trompe plutôt vers le trop : il vaut mieux cacher un numéro de réservation que laisser passer un téléphone.
 */

export const PII_MASK = "[donnée personnelle masquée]";
const EMAIL_MASK = "[e-mail masqué]", PHONE_MASK = "[téléphone masqué]", IBAN_MASK = "[IBAN masqué]", CARD_MASK = "[carte masquée]", SECRET_MASK = "[secret masqué]";

// Partie locale bornée (64) et ancrée par un lookbehind : pas de retour arrière quadratique sur une longue suite sans « @ » (relecture US-034).
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@(?:[\p{L}\p{N}-]{1,63}\.)+[\p{L}\p{N}-]{2,63}/gu;
// jeton de webhook dans une adresse, clés d'API, en-têtes Authorization, paires « clé = valeur » qui portent un secret
const SECRETS: RegExp[] = [
  /\bwhsec_[A-Za-z0-9+/=_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, // JWT
  /\b(?:ghp|gho|ghs|ghu|github_pat)_\w{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi, // mot de passe dans une adresse de connexion (postgres://user:motdepasse@hôte)
  /(?<=\/webhooks\/superhote\/)[A-Za-z0-9_-]{16,}/g,
];
const AUTH_HEADER = /\b(authorization["']?\s*[:=]\s*["']?)[^\r\n"']+/gi;
const KEY_VALUE_SECRET = /\b((?:api[_-]?key|token|jeton|secret|password|mot[_ -]?de[_ -]?passe|passwd)["']?\s*[:=]\s*["']?)(?!\[secret)([^\s"',;&]{6,})/gi;
// IBAN (2 lettres, 2 chiffres, 11 à 30 caractères) : validé par la clé modulo 97 pour ne pas masquer n'importe quel identifiant
const IBAN = /(?<![\w])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?(?![\w])/g;
// carte bancaire : 15 à 19 chiffres, séparés ou non par des espaces ou tirets, validés par la clé de Luhn
const CARD = /(?<![\w])(?:\d[ -]?){14,18}\d(?![\w])/g;
// téléphone : format international (+ ou 00) ou national français (0[1-9] puis 4 paires). Un nombre nu (identifiant, montant, horodatage) n'est jamais pris pour un téléphone.
// Le national exige un séparateur IDENTIQUE entre les paires (ou aucun) : « 2026-12-01 2026-12-02 » n'est donc pas un téléphone.
const PHONE_INTL = /(?<![\w+-])(?:\+|00)(?!\d{4}-\d{2}-\d{2})\d{1,3}(?:[ . -]?(?:\(0\)|\(?\d{1,4}\)?)){2,6}(?![\w]|[.,-]\d)/g;
const PHONE_FR = /(?<![\w+-])0[1-9](?:\d{8}|([ . -])\d{2}(?:\1\d{2}){3})(?![\w]|[.,-]\d)/g;

const digitsOf = (s: string) => s.replace(/\D/g, "");

function luhn(digits: string): boolean {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}
function ibanValid(compact: string): boolean {
  if (compact.length < 15 || compact.length > 34) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Remplace dans un texte libre les e-mails, téléphones, IBAN, cartes bancaires et secrets. Un texte sans donnée personnelle est rendu tel quel. */
export function maskPii(input: string): string {
  if (!input) return input;
  let out = input;
  const hasAt = input.includes("@");
  for (const re of SECRETS) out = out.replace(re, (m, g1) => (typeof g1 === "string" && m.startsWith(g1) ? g1 + SECRET_MASK : SECRET_MASK));
  out = out.replace(AUTH_HEADER, (_m, k: string) => k + SECRET_MASK);
  out = out.replace(KEY_VALUE_SECRET, (_m, k: string) => k + SECRET_MASK);
  if (hasAt) out = out.replace(EMAIL, EMAIL_MASK);
  out = out.replace(IBAN, (m) => (ibanValid(m.replace(/ /g, "")) ? IBAN_MASK : m));
  out = out.replace(CARD, (m) => { const d = digitsOf(m); return d.length >= 15 && d.length <= 19 && luhn(d) ? CARD_MASK : m; });
  out = out.replace(PHONE_INTL, (m) => { const n = digitsOf(m).length; return n >= 9 && n <= 15 ? PHONE_MASK : m; });
  out = out.replace(PHONE_FR, PHONE_MASK);
  return out;
}
export const containsPii = (input: string): boolean => maskPii(input) !== input;

/**
 * Clés qui portent l'identité ou les propos d'un voyageur : leur valeur n'est jamais conservée ni transmise, quel que soit son contenu.
 * Les compteurs (`guests_count`, `guest_count`) ne sont PAS concernés : ce ne sont pas des personnes.
 */
const TRAVELLER_KEY = /^(?:guest|traveler|traveller|voyageur|customer)(?:_?(?:name|email|phone|mobile|address|first_?name|last_?name|full_?name|id_?number|document\w*))?$|^(?:first_?name|last_?name|full_?name|surname|given_?name|birth\w*|date_?of_?birth|dob|passport\w*|national_?id|nationality|private_?notes?|guest_?notes?)$/i;
/** Coordonnées de toute personne (voyageur, propriétaire, utilisateur) : masquées dans les journaux et les envois LLM, pas dans le journal d'audit qui les consigne à dessein. */
const CONTACT_KEY = /^(?:e_?mail|phone|mobile|telephone|street|postal_?code|zip(?:_?code)?)$/i;
const normKey = (key: string) => key.replace(/[\s-]+/g, "_").replace(/([a-z])([A-Z])/g, "$1_$2");
export const isTravellerKey = (key: string): boolean => TRAVELLER_KEY.test(normKey(key));
export const isPiiKey = (key: string): boolean => { const k = normKey(key); return TRAVELLER_KEY.test(k) || CONTACT_KEY.test(k); };

const MAX_ENTRIES = 200;
const cap = <T,>(items: T[]): (T | string)[] => (items.length > MAX_ENTRIES ? [...items.slice(0, MAX_ENTRIES), `[… ${items.length - MAX_ENTRIES} éléments omis]`] : items);

/**
 * Copie profonde d'une valeur sans donnée personnelle : clés d'identité masquées, texte nettoyé. Borne la profondeur et la largeur.
 * `seen` ne contient que les ancêtres en cours : un même objet cité deux fois n'est pas pris pour un cycle.
 */
export function redactPii(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): unknown {
  if (typeof value === "string") return maskPii(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return PII_MASK;
  if (seen.has(value)) return "[référence circulaire]";
  if (value instanceof Date || value instanceof RegExp || ArrayBuffer.isView(value)) return value;
  if (typeof URL !== "undefined" && value instanceof URL) return maskPii(value.href);
  seen.add(value);
  try {
    const sub = (v: unknown) => redactPii(v, seen, depth + 1);
    if (value instanceof Error) return maskError(value, seen, depth);
    if (typeof Headers !== "undefined" && value instanceof Headers) return Object.fromEntries(cap([...value.entries()]).map((e) => (typeof e === "string" ? ["…", e] : [e[0], /^(?:authorization|cookie|set-cookie|x-api-key)$/i.test(e[0]) ? SECRET_MASK : maskPii(e[1])])));
    if (value instanceof Map) return cap([...value]).map((e) => (typeof e === "string" ? e : [sub(e[0]), sub(e[1])]));
    if (value instanceof Set) return cap([...value]).map(sub);
    if (Array.isArray(value)) return cap(value).map((v) => (typeof v === "string" && v.startsWith("[… ") ? v : sub(v)));
    const entries = cap(Object.entries(value as Record<string, unknown>));
    const out: Record<string, unknown> = {};
    for (const e of entries) { if (typeof e === "string") out["…"] = e; else out[e[0]] = isPiiKey(e[0]) && e[1] !== null && e[1] !== undefined && e[1] !== "" ? PII_MASK : sub(e[1]); }
    // une instance de classe garde sa classe (affichage « Classe { … } »)
    const proto = Object.getPrototypeOf(value);
    return proto && proto !== Object.prototype ? Object.assign(Object.create(proto), out) : out;
  } finally { seen.delete(value); }
}

/** Même erreur (même classe, même pile lisible), message, pile et détails nettoyés : une erreur de base de données peut citer une valeur (« Key (email)=(…) already exists »). */
function maskError(err: Error, seen: WeakSet<object>, depth: number): Error {
  const clone = Object.create(Object.getPrototypeOf(err)) as Error;
  const hidden = (v: unknown) => ({ value: v, enumerable: false, writable: true, configurable: true });
  Object.defineProperties(clone, { message: hidden(maskPii(err.message)), stack: hidden(err.stack ? maskPii(err.stack) : undefined), name: hidden(err.name) });
  for (const [k, v] of Object.entries(err)) (clone as unknown as Record<string, unknown>)[k] = isPiiKey(k) ? PII_MASK : redactPii(v, seen, depth + 1);
  if (err instanceof AggregateError) Object.defineProperty(clone, "errors", hidden(err.errors.map((e) => redactPii(e, seen, depth + 1))));
  if ("cause" in err && err.cause !== undefined) Object.defineProperty(clone, "cause", hidden(redactPii(err.cause, seen, depth + 1)));
  return clone;
}

/**
 * Minimisation : ne garde de `source` que les chemins listés (« a.b.c »). Tout le reste, identité du voyageur comprise, disparaît à l'entrée.
 * Les listes d'autorisation sont plus sûres que les listes d'interdiction : un nouveau champ de l'API reste exclu tant qu'on ne l'a pas choisi.
 */
export function pickAllowed(source: unknown, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const get = (o: unknown, parts: string[]): unknown => parts.reduce<unknown>((acc, p) => (acc !== null && typeof acc === "object" ? (acc as Record<string, unknown>)[p] : undefined), o);
  for (const path of allowed) {
    const parts = path.split(".");
    const v = get(source, parts);
    if (v === undefined) continue;
    let cur = out;
    parts.slice(0, -1).forEach((p) => { cur = (cur[p] ??= {}) as Record<string, unknown>; });
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

/** Arguments d'un `console.*` sans donnée personnelle (texte nettoyé, objets et erreurs copiés puis nettoyés). Les formats `%s`/`%o` restent valables. */
export const maskLogArgs = (args: unknown[]): unknown[] => args.map((a) => { try { return redactPii(a); } catch { return "[argument illisible : non affiché par précaution]"; } });

const LEVELS = ["log", "info", "warn", "error", "debug"] as const;
const installed = new WeakSet<object>();
/**
 * Enveloppe `console.log/info/warn/error/debug` pour masquer les données personnelles de tout ce qui est journalisé, y compris par les bibliothèques.
 * Active par défaut ; LOG_PII_MASKING=off la désactive (débogage local seulement). Idempotente. Renvoie false si rien n'a été installé.
 */
export function installLogMasking(target: Pick<Console, (typeof LEVELS)[number]> = console, env: Record<string, string | undefined> = process.env): boolean {
  if ((env.LOG_PII_MASKING ?? "").trim().toLowerCase() === "off" || installed.has(target)) return false;
  installed.add(target);
  for (const level of LEVELS) {
    const original = target[level].bind(target) as (...a: unknown[]) => void;
    target[level] = (...args: unknown[]) => {
      original(...maskLogArgs(args));
    };
  }
  return true;
}
