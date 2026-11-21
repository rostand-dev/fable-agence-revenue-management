/**
 * Portefeuille (US-020) : validation pure des saisies Propriétaire, Logement et Annonce.
 * Aucun accès base : les services (lib/services/portfolio.ts) et l'API REST s'appuient sur ces mêmes règles.
 * Un champ vide reste « inconnu » (null) ; rien n'est jamais remplacé par une valeur par défaut inventée.
 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const clean = (v: unknown): string => (typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "");
const orNull = (v: string): string | null => (v === "" ? null : v);

export const LISTING_CHANNELS = ["AIRBNB", "BOOKING", "DIRECT"] as const;
export type ListingChannel = (typeof LISTING_CHANNELS)[number];
export const isListingChannel = (v: unknown): v is ListingChannel => typeof v === "string" && (LISTING_CHANNELS as readonly string[]).includes(v);
export const LISTING_CHANNEL_LABEL: Record<ListingChannel, string> = { AIRBNB: "Airbnb", BOOKING: "Booking.com", DIRECT: "Réservation directe" };
export const LISTING_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type OwnerInput = { name: string; email: string | null; notes: string | null };
export function parseOwnerInput(raw: { name?: unknown; email?: unknown; notes?: unknown }): Parsed<OwnerInput> {
  const name = clean(raw.name), email = clean(raw.email).toLowerCase(), notes = typeof raw.notes === "string" ? raw.notes.trim() : "";
  if (name.length < 2) return fail("Le nom du propriétaire doit compter au moins 2 caractères.");
  if (name.length > 80) return fail("Le nom du propriétaire est limité à 80 caractères.");
  if (email && (email.length > 120 || !EMAIL.test(email))) return fail("L'adresse e-mail du propriétaire n'est pas valide.");
  if (notes.length > 500) return fail("Les notes sont limitées à 500 caractères.");
  return { ok: true, value: { name, email: orNull(email), notes: orNull(notes) } };
}

export type PropertyIdentity = { name: string; city: string; kind: string; bedrooms: number | null; capacity: number | null; positioning: string | null; objective: string | null };
const intOrNull = (v: unknown, max: number, label: string): Parsed<number | null> => {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  if (!Number.isInteger(n) || n < 0 || n > max) return fail(`${label} : entier entre 0 et ${max}, ou vide si inconnu.`);
  return { ok: true, value: n };
};
/** Identité complète d'un logement (création, ou remplacement des champs d'identité). */
export function parsePropertyIdentity(raw: Record<string, unknown>): Parsed<PropertyIdentity> {
  const name = clean(raw.name), city = clean(raw.city), kind = clean(raw.kind);
  if (name.length < 2 || name.length > 80) return fail("Le nom du logement compte entre 2 et 80 caractères.");
  if (city.length < 2 || city.length > 80) return fail("La ville compte entre 2 et 80 caractères.");
  if (!kind || kind.length > 40) return fail("Le type du logement (T2, T3, maison…) est nécessaire, 40 caractères au plus.");
  const bedrooms = intOrNull(raw.bedrooms, 50, "Chambres"); if (!bedrooms.ok) return bedrooms;
  const capacity = intOrNull(raw.capacity, 100, "Voyageurs maximum"); if (!capacity.ok) return capacity;
  const positioning = clean(raw.positioning), objective = clean(raw.objective);
  if (positioning.length > 200 || objective.length > 300) return fail("Clientèle visée : 200 caractères au plus ; objectif : 300 au plus.");
  return { ok: true, value: { name, city, kind, bedrooms: bedrooms.value, capacity: capacity.value, positioning: orNull(positioning), objective: orNull(objective) } };
}
/** Modification partielle : seuls les champs présents changent ; chacun suit les mêmes règles que la création. */
export function parsePropertyPatch(raw: Record<string, unknown>, current: PropertyIdentity): Parsed<{ identity: PropertyIdentity; changed: string[] }> {
  const keys = ["name", "city", "kind", "bedrooms", "capacity", "positioning", "objective"] as const;
  // rien d'identitaire dans la demande (ex. changement de propriétaire seul) : on ne revalide pas un brouillon encore incomplet
  if (!keys.some((k) => k in raw)) return { ok: true, value: { identity: current, changed: [] } };
  const merged: Record<string, unknown> = { ...current };
  const changed: string[] = [];
  for (const k of keys) if (k in raw) { merged[k] = raw[k]; }
  const r = parsePropertyIdentity(merged);
  if (!r.ok) return r;
  for (const k of Object.keys(r.value) as (keyof PropertyIdentity)[]) if ((r.value[k] ?? null) !== (current[k] ?? null)) changed.push(k);
  return { ok: true, value: { identity: r.value, changed } };
}

export type ListingInput = { channel: ListingChannel; externalId: string | null; url: string | null; title: string | null };
const HOST: Record<ListingChannel, RegExp | null> = { AIRBNB: /(^|\.)airbnb\.(com|[a-z]{2})(\.[a-z]{2})?$/i, BOOKING: /(^|\.)booking\.com$/i, DIRECT: null };
const ID_SHAPE: Record<ListingChannel, { re: RegExp; hint: string }> = {
  AIRBNB: { re: /^\d{5,20}$/, hint: "L'identifiant d'une annonce Airbnb est un nombre (par exemple 12345678), visible dans son adresse après /rooms/." },
  BOOKING: { re: /^\d{3,12}$/, hint: "L'identifiant d'un établissement Booking.com est un nombre (visible dans l'extranet, rubrique Propriété)." },
  DIRECT: { re: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, hint: "L'identifiant d'une annonce directe : lettres, chiffres, point, tiret ou souligné, 64 caractères au plus." },
};
/** Adresse web d'une annonce : https obligatoire, nom de domaine cohérent avec le canal, sans identifiant de connexion. */
export function parseListingUrl(channel: ListingChannel, raw: string): Parsed<string> {
  let u: URL;
  try { u = new URL(raw); } catch { return fail("L'adresse de l'annonce n'est pas une adresse web valide (https://…)."); }
  if (u.protocol !== "https:") return fail("L'adresse de l'annonce doit commencer par https://.");
  if (u.username || u.password) return fail("L'adresse de l'annonce ne doit contenir ni identifiant ni mot de passe.");
  const host = HOST[channel];
  if (host && !host.test(u.hostname)) return fail(`Cette adresse ne semble pas être celle d'une annonce ${LISTING_CHANNEL_LABEL[channel]}.`);
  const out = u.origin + u.pathname.replace(/\/+$/, "");
  return out.length > 300 ? fail("L'adresse de l'annonce est trop longue (300 caractères au plus).") : { ok: true, value: out };
}
/** Identifiant Airbnb déduit d'une adresse du type https://www.airbnb.fr/rooms/12345678 (aucune lecture du web). */
export function airbnbIdFromUrl(url: string): string | null {
  const m = /\/rooms\/(?:plus\/)?(\d{5,20})(?:[/?#]|$)/.exec(url);
  return m ? m[1] : null;
}
export function parseListingInput(raw: { channel?: unknown; externalId?: unknown; url?: unknown; title?: unknown }): Parsed<ListingInput> {
  if (!isListingChannel(raw.channel)) return fail("Canal inconnu : Airbnb, Booking.com ou réservation directe.");
  const channel = raw.channel;
  let url: string | null = null;
  const rawUrl = clean(raw.url);
  if (rawUrl) { const r = parseListingUrl(channel, rawUrl); if (!r.ok) return r; url = r.value; }
  let externalId = clean(raw.externalId).replace(/\s/g, "") || null;
  // l'identifiant Airbnb se déduit de l'adresse quand il n'est pas saisi ; saisi, il doit concorder avec elle
  if (channel === "AIRBNB" && url) {
    const fromUrl = airbnbIdFromUrl(url);
    if (fromUrl && !externalId) externalId = fromUrl;
    if (fromUrl && externalId && fromUrl !== externalId) return fail(`L'identifiant saisi (${externalId}) ne correspond pas à celui de l'adresse (${fromUrl}).`);
  }
  if (externalId && !ID_SHAPE[channel].re.test(externalId)) return fail(ID_SHAPE[channel].hint);
  const title = clean(raw.title);
  if (title.length > 120) return fail("Le titre de l'annonce est limité à 120 caractères.");
  return { ok: true, value: { channel, externalId, url, title: orNull(title) } };
}

export function parseTenantName(raw: unknown): Parsed<string> {
  const name = clean(raw);
  if (name.length < 2 || name.length > 80) return fail("Le nom de l'espace compte entre 2 et 80 caractères.");
  return { ok: true, value: name };
}
