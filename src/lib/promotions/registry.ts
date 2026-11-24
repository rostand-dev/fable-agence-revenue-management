/**
 * Registre des promotions actives (US-100, blueprint §10.3).
 *
 * Module pur, sans accès base : il valide la saisie d'une promotion, dit où elle en est (en cours, à venir, passée, à vérifier)
 * et repère les doublons et les cumuls inconnus. Le service `services/promotion-registry.ts` l'applique.
 *
 * Le registre est TENU À LA MAIN tant qu'aucun accès partenaire officiel n'existe (Airbnb, Booking.com) : il reflète ce que le
 * propriétaire ou l'opérateur a relevé dans l'extranet du canal, avec la date de cette lecture. Rien ici n'écrit chez un canal.
 */
import { addDays, type ISODate } from "../dates";
import { MAX_AGE_HOURS } from "../freshness";
import { evaluateStacking, kindsOf, overlapsWindow, promoKind } from "../stacking/rules";
import type { Channel } from "../engine/types";

export const PROMO_CHANNELS = ["BOOKING", "AIRBNB"] as const satisfies readonly Channel[];
export type PromoStatus = "PLANNED" | "ACTIVE" | "ENDED";

/** Audience visée, déduite du type de promotion (le voyageur ne choisit pas : c'est le canal qui décide à qui l'offre s'affiche). */
export const AUDIENCE_LABEL: Record<string, string> = {
  ALL: "Tous les voyageurs", MOBILE: "Voyageurs sur mobile", MEMBERS: "Membres du programme du canal", COUNTRY: "Voyageurs d'un pays donné",
};
const AUDIENCE_OF_KIND: Record<string, string> = { MOBILE: "MOBILE", GENIUS: "MEMBERS", COUNTRY: "COUNTRY" };
export const audienceOfKind = (kind: string): string => AUDIENCE_OF_KIND[kind] ?? "ALL";

/** Une promotion non vérifiée depuis plus longtemps que cela est tenue pour incertaine (même seuil que la fraîcheur des données, 7 jours). */
export const VERIFY_MAX_AGE_DAYS = MAX_AGE_HOURS.PROMOTIONS / 24;
export const MAX_DISCOUNT_PCT = 80;

export type CleanPromotion = {
  channel: Channel; kind: string; label: string; discountPct: number;
  stayFrom: ISODate | null; stayTo: ISODate | null; bookFrom: ISODate | null; bookTo: ISODate | null;
  minLos: number | null; audience: string; listingId: string | null; externalRef: string | null;
};
export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string): boolean => ISO.test(s) && s >= "2000-01-01" && s <= "2100-12-31" && !Number.isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const text = (v: unknown, max: number): string => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
/** Champ vide = pas de valeur, jamais zéro ni date par défaut. */
const opt = (v: unknown): string | null => { const t = String(v ?? "").trim(); return t === "" ? null : t; };
const fmt = (d: ISODate) => d.split("-").reverse().join("/");

/**
 * Valide et nettoie la saisie d'une promotion. Tout refus dit quoi corriger, en une phrase.
 * `today` sert à refuser une promotion dont les séjours sont déjà passés (rien à vendre, rien à surveiller).
 */
export function validatePromotion(raw: Record<string, unknown>, today: ISODate): Checked<CleanPromotion> {
  const channel = String(raw.channel ?? "").toUpperCase();
  if (!(PROMO_CHANNELS as readonly string[]).includes(channel)) return { ok: false, error: "Choisissez le canal : Booking.com ou Airbnb." };
  const kind = String(raw.kind ?? "").toUpperCase();
  const def = promoKind(channel, kind);
  if (!def) return { ok: false, error: `Choisissez un type de promotion connu de ${channel === "BOOKING" ? "Booking.com" : "Airbnb"} : ${kindsOf(channel as Channel).map((k) => k.label).join(", ")}.` };
  const pctRaw = String(raw.discountPct ?? "").replace(",", ".").trim();
  const discountPct = /^\d{1,2}([.]\d{1,2})?$/.test(pctRaw) ? Number(pctRaw) : NaN;
  if (pctRaw === "" || !Number.isFinite(discountPct) || discountPct < 1 || discountPct > MAX_DISCOUNT_PCT) return { ok: false, error: `La remise doit être un pourcentage entre 1 et ${MAX_DISCOUNT_PCT} (par exemple 10).` };
  const stayFrom = opt(raw.stayFrom), stayTo = opt(raw.stayTo), bookFrom = opt(raw.bookFrom), bookTo = opt(raw.bookTo);
  if ((stayFrom === null) !== (stayTo === null)) return { ok: false, error: "Renseignez les deux dates de séjour, ou aucune pour une promotion permanente." };
  if ((bookFrom === null) !== (bookTo === null)) return { ok: false, error: "Renseignez les deux dates de réservation, ou aucune si la promotion s'applique à toute date de réservation." };
  for (const [name, v] of [["de début de séjour", stayFrom], ["de fin de séjour", stayTo], ["de début de réservation", bookFrom], ["de fin de réservation", bookTo]] as const) {
    if (v !== null && !validDate(v)) return { ok: false, error: `La date ${name} n'est pas valide (format attendu : jj/mm/aaaa).` };
  }
  if (stayFrom && stayTo) {
    if (stayTo <= stayFrom) return { ok: false, error: "La fin des séjours doit tomber après leur début (le jour de départ de la dernière nuit n'est pas compris)." };
    if (stayTo <= today) return { ok: false, error: `Les séjours de cette promotion sont déjà passés (fin le ${fmt(stayTo)}) : elle n'a plus rien à vendre. Ne la déclarez pas.` };
    if (stayFrom > addDays(today, 730)) return { ok: false, error: "Les séjours commencent dans plus de deux ans : vérifiez la date." };
  }
  if (bookFrom && bookTo && bookTo < bookFrom) return { ok: false, error: "La fin de la période de réservation doit tomber le même jour ou après son début." };
  const losRaw = opt(raw.minLos);
  let minLos: number | null = null;
  if (losRaw !== null) {
    minLos = /^\d{1,3}$/.test(losRaw) ? Number(losRaw) : NaN;
    if (!Number.isInteger(minLos) || minLos < 1 || minLos > 365) return { ok: false, error: "La durée minimale de séjour est un nombre entier de nuits, de 1 à 365 (laissez vide s'il n'y en a pas)." };
  }
  const ref = opt(raw.externalRef);
  if (ref !== null && !/^[\p{L}\p{N} ._:#/\-]{1,120}$/u.test(ref)) return { ok: false, error: "L'identifiant relevé dans l'extranet ne peut contenir que des lettres, des chiffres et . _ : # / - (120 caractères au plus)." };
  const label = text(raw.label, 120) || def.label;
  return { ok: true, value: { channel: channel as Channel, kind, label, discountPct: Math.round(discountPct * 10) / 10, stayFrom, stayTo, bookFrom, bookTo, minLos, audience: audienceOfKind(kind), listingId: opt(raw.listingId), externalRef: ref } };
}

export type RegistryRow = {
  id: string; channel: string; kind: string; label: string; discountPct: number; status: string;
  stayFrom: ISODate | null; stayTo: ISODate | null; listingId: string | null; verifiedAt: Date | null;
};

/** Deux promotions se gênent si elles sont du même canal, du même type, visent la même annonce (ou l'une vise toutes) et recoupent leurs séjours. */
export function findDuplicate(existing: RegistryRow[], c: Pick<CleanPromotion, "channel" | "kind" | "stayFrom" | "stayTo" | "listingId">, ignoreId?: string): RegistryRow | undefined {
  return existing.find((e) => e.id !== ignoreId && e.status !== "ENDED" && e.channel === c.channel && e.kind === c.kind
    && (!e.listingId || !c.listingId || e.listingId === c.listingId)
    && overlapsWindow(e, c.stayFrom ?? "0000-01-01", c.stayTo ?? "9999-12-31"));
}

export type Phase = "RUNNING" | "UPCOMING" | "PAST" | "PERMANENT";
export type Freshness = "FRESH" | "STALE" | "NEVER";
export type PromoView = {
  /** État affiché : une promotion « active » dont les séjours sont passés s'affiche « expirée » sans attendre le balayage planifié */
  state: "ACTIVE" | "PLANNED" | "ENDED" | "EXPIRED";
  phase: Phase;
  freshness: Freshness;
  /** Jours depuis la dernière vérification (null = jamais) */
  ageDays: number | null;
  /** Date limite avant laquelle relire l'extranet pour que la promotion reste « vérifiée » (null = jamais vérifiée ou terminée) */
  verifyBefore: ISODate | null;
};

const dayDiff = (a: Date, b: Date) => Math.floor((+b - +a) / 86_400_000);

/** Où en est une promotion du registre, à la date `today` (jour civil Europe/Paris, fourni par l'appelant) et à l'instant `now`. */
export function promotionView(p: { status: string; stayFrom: ISODate | null; stayTo: ISODate | null; verifiedAt: Date | null }, today: ISODate, now: Date): PromoView {
  const phase: Phase = !p.stayFrom || !p.stayTo ? "PERMANENT" : p.stayTo <= today ? "PAST" : p.stayFrom > today ? "UPCOMING" : "RUNNING";
  const state: PromoView["state"] = p.status === "ENDED" ? "ENDED" : phase === "PAST" ? "EXPIRED" : p.status === "PLANNED" ? "PLANNED" : "ACTIVE";
  const ageDays = p.verifiedAt ? Math.max(0, dayDiff(p.verifiedAt, now)) : null;
  const freshness: Freshness = ageDays === null ? "NEVER" : ageDays > VERIFY_MAX_AGE_DAYS ? "STALE" : "FRESH";
  const live = state === "ACTIVE";
  return { state, phase, freshness, ageDays, verifyBefore: live && p.verifiedAt ? addDays(p.verifiedAt.toISOString().slice(0, 10), VERIFY_MAX_AGE_DAYS) : null };
}

/**
 * Cumuls dont la règle est inconnue (US-003) entre promotions actives qui se recoupent : pour chaque promotion, la liste des autres
 * avec lesquelles on ne sait pas si elle se cumule. Sert d'avertissement dans le registre ; la décision reste à l'auditeur.
 */
export function unknownStacking(rows: RegistryRow[], today: ISODate): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const live = rows.filter((r) => r.status === "ACTIVE" && !(r.stayTo && r.stayTo <= today));
  for (const channel of PROMO_CHANNELS) {
    const group = live.filter((r) => r.channel === channel);
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const a = group[i], b = group[j];
      if (a.listingId && b.listingId && a.listingId !== b.listingId) continue;
      if (!overlapsWindow(a, b.stayFrom ?? "0000-01-01", b.stayTo ?? "9999-12-31")) continue;
      const ev = evaluateStacking(channel, [{ id: a.id, kind: a.kind, label: a.label }, { id: b.id, kind: b.kind, label: b.label }]);
      if (!ev.needsHuman) continue;
      out.set(a.id, [...(out.get(a.id) ?? []), b.label]);
      out.set(b.id, [...(out.get(b.id) ?? []), a.label]);
    }
  }
  return out;
}
