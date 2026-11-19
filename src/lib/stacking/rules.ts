/**
 * Registre des règles de cumul des promotions par canal (US-003, blueprint §10.4).
 *
 * Question posée : deux promotions d'un même canal, valables sur les mêmes nuits, se cumulent-elles ?
 * Réponse possible : CUMULABLES, EXCLUSIVES (une seule s'applique) ou INCONNUE. Une règle inconnue n'est jamais
 * devinée : l'auditeur renvoie `NEEDS_HUMAN` (règle d'audit `STACK_RULES`, voir `engine/audit.ts`).
 *
 * Source de vérité : les aides officielles des canaux, avec leur adresse et la date de consultation. Ce qu'elles ne disent pas
 * explicitement reste INCONNU, même si des blogs ou des channel managers affirment le contraire.
 * Module pur (aucun accès base) : testable, et sert aussi à générer `docs/regles-de-cumul.md`.
 */
import type { ISODate } from "../dates";
import type { Channel } from "../engine/types";

export type StackStatus = "STACKS" | "EXCLUSIVE" | "UNKNOWN";
export const STACK_STATUS: Record<StackStatus, { label: string; role: "sain" | "tech" | "attention" }> = {
  STACKS: { label: "Cumulables", role: "sain" },
  EXCLUSIVE: { label: "Une seule s'applique", role: "tech" },
  UNKNOWN: { label: "Inconnue", role: "attention" },
};

export type PromoKindDef = { channel: Channel; kind: string; label: string };
export type Source = { id: string; label: string; url: string; checkedAt: ISODate; note: string };

/** Date de la dernière relecture des sources officielles, saisie à la main par l'équipe : à mettre à jour chaque fois qu'on les relit. */
export const RULES_CHECKED_AT: ISODate = "2026-11-19";

export const SOURCES: Record<string, Source> = {
  AIRBNB_DISCOUNTS: {
    id: "AIRBNB_DISCOUNTS", label: "Aide Airbnb · Remises et promotions (logements)", url: "https://www.airbnb.com/help/article/3421", checkedAt: RULES_CHECKED_AT,
    note: "La page ne porte pas de date de mise à jour.",
  },
  AIRBNB_RULESET: {
    id: "AIRBNB_RULESET", label: "Aide Airbnb · Ordre d'application des règles de tarification", url: "https://www.airbnb.com/help/article/2061", checkedAt: RULES_CHECKED_AT,
    note: "La page ne porte pas de date de mise à jour. Son exemple applique la remise mensuelle plutôt que l'early-bird, sans énoncer de règle générale.",
  },
  BOOKING_DISCOUNTS: {
    id: "BOOKING_DISCOUNTS", label: "Booking.com · Demand API, remises", url: "https://developers.booking.com/demand/docs/accommodations/discounts", checkedAt: RULES_CHECKED_AT,
    note: "Décrit les tarifs de groupe fermé (CUG), Genius cité en exemple ; ne vise pas expressément l'extranet partenaire. Date de mise à jour affichée en relatif seulement.",
  },
};

export const PROMO_KINDS: PromoKindDef[] = [
  { channel: "BOOKING", kind: "GENIUS", label: "Genius (tarif réservé aux membres)" },
  { channel: "BOOKING", kind: "MOBILE", label: "Tarif mobile" },
  { channel: "BOOKING", kind: "COUNTRY", label: "Tarif par pays" },
  { channel: "BOOKING", kind: "LIMITED", label: "Offre à durée limitée" },
  { channel: "AIRBNB", kind: "NEW_LISTING", label: "Promotion nouvelle annonce" },
  { channel: "AIRBNB", kind: "CUSTOM", label: "Promotion personnalisée" },
  { channel: "AIRBNB", kind: "LOS", label: "Remise de durée de séjour (hebdomadaire, mensuelle, personnalisée)" },
  { channel: "AIRBNB", kind: "EARLY_BIRD", label: "Remise early-bird" },
  { channel: "AIRBNB", kind: "LAST_MINUTE", label: "Remise dernière minute" },
  { channel: "AIRBNB", kind: "TOP_RATED", label: "Remise voyageur très bien noté" },
];
export const kindsOf = (c: Channel): PromoKindDef[] => PROMO_KINDS.filter((k) => k.channel === c);
export const promoKind = (channel: string, kind: string): PromoKindDef | undefined => PROMO_KINDS.find((k) => k.channel === channel && k.kind === kind);

export type StackRule = { channel: Channel; a: string; b: string; status: StackStatus; source?: string; detail: string };

const AIRBNB_STANDARD = ["NEW_LISTING", "CUSTOM", "LOS", "EARLY_BIRD", "LAST_MINUTE"];
const BOOKING_NO_RULE = "La documentation officielle ne dit pas si ces deux offres se cumulent. Les affirmations de blogs ou de channel managers ne sont pas retenues.";
const BOOKING_GENIUS = "Selon la documentation officielle de Booking.com (tarifs de groupe fermé, dont Genius est un exemple), un tarif réservé aux membres peut se cumuler avec d'autres remises à une condition : le « rate stacking » activé sur le compte partenaire. NuitSignal n'a aucun accès au compte Booking.com pour le vérifier.";

/** Règles explicites. Toute paire absente de cette liste est INCONNUE, par défaut. */
export const STACK_RULES: StackRule[] = [
  // Airbnb : « pour un logement, une seule des remises principales s'applique à une réservation » ; la remise voyageur très bien noté est l'exception.
  ...AIRBNB_STANDARD.flatMap((a, i) => AIRBNB_STANDARD.slice(i).map((b): StackRule => ({
    channel: "AIRBNB", a, b, status: "EXCLUSIVE", source: "AIRBNB_DISCOUNTS",
    detail: "Une seule des remises principales s'applique à une réservation. Laquelle l'emporte n'est pas énoncé par l'aide officielle : le simulateur retient le cumul, hypothèse prudente pour le plancher, mais l'effet réel de la seconde promotion peut être nul.",
  }))),
  ...AIRBNB_STANDARD.map((a): StackRule => ({
    channel: "AIRBNB", a, b: "TOP_RATED", status: "STACKS", source: "AIRBNB_DISCOUNTS",
    detail: "La remise voyageur très bien noté est la seule à se cumuler avec les autres remises principales.",
  })),
  // Booking.com : seule la documentation des tarifs réservés aux membres parle de cumul, sous condition.
  ...["MOBILE", "COUNTRY", "LIMITED"].map((b): StackRule => ({ channel: "BOOKING", a: "GENIUS", b, status: "UNKNOWN", source: "BOOKING_DISCOUNTS", detail: BOOKING_GENIUS })),
  { channel: "BOOKING", a: "GENIUS", b: "GENIUS", status: "UNKNOWN", source: "BOOKING_DISCOUNTS", detail: BOOKING_GENIUS },
];

const DEFAULT_UNKNOWN: Record<Channel, string> = {
  BOOKING: BOOKING_NO_RULE,
  AIRBNB: "L'aide officielle d'Airbnb ne traite pas cette combinaison.",
};

export type PairRule = { channel: Channel; a: string; b: string; status: StackStatus; source: Source | null; detail: string };

const same = (r: StackRule, a: string, b: string) => (r.a === a && r.b === b) || (r.a === b && r.b === a);

/** Règle de cumul de deux types de promotion d'un canal. Un type absent du registre rend la règle INCONNUE. */
export function ruleFor(channel: Channel, a: string, b: string): PairRule {
  a = a.trim().toUpperCase(); b = b.trim().toUpperCase();
  const unknownKind = [a, b].filter((k) => !promoKind(channel, k));
  if (unknownKind.length) {
    return { channel, a, b, status: "UNKNOWN", source: null, detail: `Type de promotion absent du registre de cumul : ${unknownKind.join(", ")}. Rien n'est supposé.` };
  }
  const r = STACK_RULES.find((x) => x.channel === channel && same(x, a, b));
  if (r) return { channel, a, b, status: r.status, source: r.source ? SOURCES[r.source] : null, detail: r.detail };
  return { channel, a, b, status: "UNKNOWN", source: null, detail: DEFAULT_UNKNOWN[channel] };
}

/** Toutes les paires d'un canal, chaque paire une fois, y compris deux promotions du même type. Sert à la documentation et à l'écran. */
export function matrix(channel: Channel): PairRule[] {
  const ks = kindsOf(channel).map((k) => k.kind);
  return ks.flatMap((a, i) => ks.slice(i).map((b) => ruleFor(channel, a, b)));
}

export type InPlayPromo = { id: string; kind: string; label: string };
export type PairVerdict = PairRule & { first: InPlayPromo; second: InPlayPromo };
export type StackEvaluation = {
  channel: Channel; count: number; pairs: PairVerdict[];
  /** Paires dont la règle est inconnue : chacune oblige à une décision humaine */
  unknown: PairVerdict[];
  needsHuman: boolean;
};

/**
 * Évalue le cumul des promotions en jeu sur un canal pour les mêmes nuits. Moins de deux promotions : rien à cumuler.
 * Toute paire inconnue est critique : le plancher a été simulé en supposant un cumul que l'on ne sait pas établi.
 */
export function evaluateStacking(channel: Channel, promos: InPlayPromo[]): StackEvaluation {
  const pairs: PairVerdict[] = [];
  for (let i = 0; i < promos.length; i++) for (let j = i + 1; j < promos.length; j++) {
    pairs.push({ ...ruleFor(channel, promos[i].kind, promos[j].kind), first: promos[i], second: promos[j] });
  }
  const unknown = pairs.filter((p) => p.status === "UNKNOWN");
  return { channel, count: promos.length, pairs, unknown, needsHuman: unknown.length > 0 };
}

/** Une promotion est en jeu pour une fenêtre [from, to[ si ses dates de séjour la recoupent ; sans date, elle est permanente. */
export function overlapsWindow(p: { stayFrom: ISODate | null; stayTo: ISODate | null }, from: ISODate, to: ISODate): boolean {
  return (!p.stayFrom || p.stayFrom < to) && (!p.stayTo || from < p.stayTo);
}

/** Paires regroupées par règle identique (même état, même explication) : lecture courte à l'écran, sans tableau de vingt lignes. */
export type RuleGroup = { status: StackStatus; detail: string; source: Source | null; pairs: [string, string][] };
export function groupedRules(channel: Channel): RuleGroup[] {
  const groups: RuleGroup[] = [];
  for (const r of matrix(channel)) {
    const pair: [string, string] = [promoKind(channel, r.a)!.label, promoKind(channel, r.b)!.label];
    const g = groups.find((x) => x.status === r.status && x.detail === r.detail);
    if (g) g.pairs.push(pair); else groups.push({ status: r.status, detail: r.detail, source: r.source, pairs: [pair] });
  }
  const order: StackStatus[] = ["UNKNOWN", "EXCLUSIVE", "STACKS"];
  return groups.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
}
