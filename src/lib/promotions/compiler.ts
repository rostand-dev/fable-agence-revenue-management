/**
 * Promotion Compiler (US-101, blueprint §10.1, §10.2 et §10.4).
 *
 * Une INTENTION commerciale (stimuler la demande proche, les longs séjours, les réservations très anticipées, cibler un marché) est
 * traduite, canal par canal, en une promotion que l'on peut réellement poser dans l'extranet, ou en un refus expliqué.
 *
 * Module pur : mêmes entrées, mêmes sorties, aucun accès base ni réseau. Il ne pose rien chez Airbnb ou Booking.com ;
 * le guide pas-à-pas (US-102) et la confirmation (US-103) prennent le relais.
 *
 * Trois états par canal, jamais une valeur devinée :
 * - COMPILED : promotion proposée, plancher respecté, cumul documenté ;
 * - NEEDS_HUMAN : promotion proposée mais une règle de cumul est inconnue ou le registre n'a pas été relu récemment ;
 * - NO_SAFE_EQUIVALENT : aucune traduction sûre (type absent du registre de cumul, plancher franchi, promotion déjà en place...).
 */
import { addDays, type ISODate } from "../dates";
import { strategyFloorWindow } from "../engine/seasons";
import { missingEconomics } from "../engine/economics";
import { simulate, type Simulation, type SimPromo } from "../engine/simulator";
import { CHANNELS, CHANNEL_LABEL, type Channel, type EconomicModel } from "../engine/types";
import { evaluateStacking, overlapsWindow, promoKind, ruleFor } from "../stacking/rules";
import { MAX_DISCOUNT_PCT, audienceOfKind, type Checked } from "./registry";

export type Intent = "STIMULATE_NEAR_TERM_DEMAND" | "STIMULATE_LONG_STAY" | "STIMULATE_EARLY_BOOKING" | "TARGET_MARKET";

/** Libellés, et correspondance du blueprint §10.2 : ce que l'intention devient sur chaque canal (le type est un type du registre de cumul). */
export const INTENTS: Record<Intent, { label: string; help: string; booking: string | null; airbnb: string | null; pricelabs: string }> = {
  STIMULATE_NEAR_TERM_DEMAND: {
    label: "Stimuler la demande proche (dernière minute)", help: "Des nuits proches de l'arrivée restent à vendre.",
    booking: "MOBILE", airbnb: "LAST_MINUTE",
    pricelabs: "Éviter la double baisse : si PriceLabs baisse déjà les prix de dernière minute, la promotion s'y ajoute. Vérifiez le prix publié avant de la poser.",
  },
  STIMULATE_LONG_STAY: {
    label: "Stimuler les longs séjours (7 nuits et plus)", help: "Remplir une période creuse avec des séjours longs.",
    booking: null, airbnb: "LOS",
    pricelabs: "Une tarification par durée de séjour dans PriceLabs reste possible, seulement si vous la contrôlez : elle n'est pas compilée ici.",
  },
  STIMULATE_EARLY_BOOKING: {
    label: "Stimuler les réservations très anticipées", help: "Sécuriser des nuits lointaines avec une remise early-bird.",
    booking: null, airbnb: "EARLY_BIRD",
    pricelabs: "Ne baissez les prix lointains (far-out) dans PriceLabs que si c'est nécessaire : la promotion suffit en général.",
  },
  TARGET_MARKET: {
    label: "Cibler un marché (pays)", help: "Un tarif réservé aux voyageurs d'un pays donné.",
    booking: "COUNTRY", airbnb: null,
    pricelabs: "Aucun équivalent dans PriceLabs.",
  },
};
export const INTENT_KEYS = Object.keys(INTENTS) as Intent[];

/** Raisons d'un refus : stables, pour l'écran, les tests et l'audit. */
export type RefusalCode = "NO_CHANNEL_TYPE" | "NOT_IN_REGISTRY" | "MISSING_DATA" | "WINDOW_TOO_SHORT" | "FLOOR" | "STACK_CAP" | "ALREADY_ACTIVE" | "EXCLUSIVE_WITH_ACTIVE";

export type CompileInput = {
  intent: Intent;
  stayFrom: ISODate; stayTo: ISODate;
  /** Remise maximale que l'opérateur accepte, en % */
  maxDiscountPct: number;
  channels: Channel[];
  /** Prix publié par nuit SUR chaque canal (majoration comprise), en centimes */
  publishedNightlyCents: Partial<Record<Channel, number>>;
  /** Séjour minimal exigé (nuits). Obligatoire pour les longs séjours ; sinon facultatif. */
  minLos: number | null;
  /** Jours avant l'arrivée : au plus (demande proche) ou au moins (très anticipé). Facultatif ailleurs. */
  advanceDays: number | null;
};

export type ActiveRow = { channel: string; kind: string; label: string; discountPct: number; stayFrom: ISODate | null; stayTo: ISODate | null };
export type CompileContext = {
  model: EconomicModel;
  maxDiscountStackPct: number | null;
  /** Promotions déjà actives (registre US-100), tous canaux ; le compilateur ne retient que celles qui recoupent la fenêtre. */
  active: ActiveRow[];
  /** Canaux dont le registre n'a pas été relu récemment (promotion jamais vérifiée ou vérifiée il y a plus de 7 jours) */
  registryStale: Partial<Record<Channel, boolean>>;
  /** Canaux sans aucune promotion au registre : le registre est tenu à la main, son silence ne prouve pas qu'il n'y a rien dans l'extranet */
  registryEmpty?: Partial<Record<Channel, boolean>>;
};

/** Ce que l'opérateur saisira dans l'extranet : repris tel quel par le guide pas-à-pas (US-102). */
export type PromotionSettings = {
  channel: Channel; kind: string; kindLabel: string; discountPct: number;
  stayFrom: ISODate; stayTo: ISODate; minLos: number | null; advanceDays: number | null; advanceMode: "AT_MOST" | "AT_LEAST" | null; audience: string;
};

export type ChannelOutcome =
  | { channel: Channel; status: "COMPILED" | "NEEDS_HUMAN"; settings: PromotionSettings; simulation: Simulation; humanReasons: string[]; notes: string[] }
  | { channel: Channel; status: "NO_SAFE_EQUIVALENT"; code: RefusalCode; reason: string };

export type CompileResult = {
  intent: Intent; outcomes: ChannelOutcome[];
  /** Ce que l'intention implique côté PriceLabs : information, jamais compilé */
  pricelabsNote: string;
};

export const MAX_WINDOW_NIGHTS = 366;
const STEP = 0.5;
/** Séjour de référence quand aucun séjour minimal n'est donné : une nuit, le cas le plus exigeant (le ménage pèse sur une seule nuit). */
export const REFERENCE_NIGHTS = 1;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => ISO.test(s) && s >= "2000-01-01" && s <= "2100-12-31" && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const nightsBetween = (a: ISODate, b: ISODate) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);

/** Lit et valide la saisie du formulaire. Les prix se saisissent en euros par nuit (virgule ou point) et deviennent des centimes entiers. */
export function parseCompileInput(raw: Record<string, unknown>, today: ISODate): Checked<CompileInput> {
  const intent = String(raw.intent ?? "") as Intent;
  if (!INTENT_KEYS.includes(intent)) return { ok: false, error: "Choisissez l'intention commerciale." };
  const stayFrom = String(raw.stayFrom ?? "").trim(), stayTo = String(raw.stayTo ?? "").trim();
  if (!validDate(stayFrom) || !validDate(stayTo)) return { ok: false, error: "Renseignez les dates de séjour (premier et dernier jour, départ exclu)." };
  if (stayTo <= stayFrom) return { ok: false, error: "La fin des séjours doit être après leur début." };
  if (stayTo <= today) return { ok: false, error: "Ces séjours sont déjà passés : il n'y a plus rien à vendre." };
  if (nightsBetween(stayFrom, stayTo) > MAX_WINDOW_NIGHTS) return { ok: false, error: `La fenêtre de séjours ne peut pas dépasser ${MAX_WINDOW_NIGHTS} nuits.` };
  const pctRaw = String(raw.maxDiscountPct ?? "").replace(",", ".").trim();
  const maxDiscountPct = /^\d{1,2}([.]\d)?$/.test(pctRaw) ? Number(pctRaw) : NaN;
  if (!Number.isFinite(maxDiscountPct) || maxDiscountPct < 1 || maxDiscountPct > MAX_DISCOUNT_PCT) return { ok: false, error: `La remise maximale doit être un pourcentage entre 1 et ${MAX_DISCOUNT_PCT} (par exemple 10 ou 7,5).` };
  const wanted = CHANNELS.filter((c) => {
    const v = raw[`channel_${c}`] ?? (Array.isArray(raw.channels) ? (raw.channels as unknown[]).includes(c) : undefined);
    return v === "on" || v === "1" || v === true;
  });
  if (!wanted.length) return { ok: false, error: "Cochez au moins un canal." };
  const publishedNightlyCents: Partial<Record<Channel, number>> = {};
  for (const c of wanted) {
    const v = String(raw[`price_${c}`] ?? "").replace(",", ".").trim();
    if (!/^\d{1,5}([.]\d{1,2})?$/.test(v) || Number(v) <= 0) return { ok: false, error: `Indiquez le prix publié par nuit sur ${CHANNEL_LABEL[c]}, en euros (par exemple 120 ou 119,50).` };
    publishedNightlyCents[c] = Math.round(Number(v) * 100);
  }
  const minLosRaw = String(raw.minLos ?? "").trim();
  let minLos: number | null = null;
  if (minLosRaw !== "") {
    if (!/^\d{1,3}$/.test(minLosRaw) || Number(minLosRaw) < 1 || Number(minLosRaw) > 365) return { ok: false, error: "Le séjour minimal est un nombre de nuits entre 1 et 365." };
    minLos = Number(minLosRaw);
  }
  if (intent === "STIMULATE_LONG_STAY") {
    if (minLos === null) minLos = 7;
    if (minLos < 2 || minLos > 90) return { ok: false, error: "Pour un long séjour, le séjour minimal est entre 2 et 90 nuits (7, 14 ou 28 en général)." };
  }
  const advRaw = String(raw.advanceDays ?? "").trim();
  let advanceDays: number | null = null;
  if (advRaw !== "") {
    if (!/^\d{1,3}$/.test(advRaw) || Number(advRaw) < 1 || Number(advRaw) > 365) return { ok: false, error: "Le délai avant l'arrivée est un nombre de jours entre 1 et 365." };
    advanceDays = Number(advRaw);
  } else if (intent === "STIMULATE_NEAR_TERM_DEMAND") advanceDays = 7;
  else if (intent === "STIMULATE_EARLY_BOOKING") advanceDays = 60;
  if (advanceDays !== null && intent === "STIMULATE_NEAR_TERM_DEMAND" && advanceDays > 60) return { ok: false, error: "Pour la demande proche, le délai avant l'arrivée est de 60 jours au plus." };
  if (advanceDays !== null && intent === "STIMULATE_EARLY_BOOKING" && advanceDays < 30) return { ok: false, error: "Pour une réservation très anticipée, le délai avant l'arrivée est de 30 jours au moins." };
  // un séjour déjà commencé ne se vend plus : la fenêtre part d'aujourd'hui au plus tôt
  const from = stayFrom < today ? today : stayFrom;
  if (intent !== "STIMULATE_NEAR_TERM_DEMAND" && intent !== "STIMULATE_EARLY_BOOKING") advanceDays = null;
  return { ok: true, value: { intent, stayFrom: from, stayTo, maxDiscountPct, channels: wanted, publishedNightlyCents, minLos, advanceDays } };
}

const refuse = (channel: Channel, code: RefusalCode, reason: string): ChannelOutcome => ({ channel, status: "NO_SAFE_EQUIVALENT", code, reason });
const fr = (d: ISODate) => d.split("-").reverse().join("/");

function compileChannel(i: CompileInput, ctx: CompileContext, channel: Channel): ChannelOutcome {
  const ch = CHANNEL_LABEL[channel];
  const intent = INTENTS[i.intent];
  const kind = channel === "BOOKING" ? intent.booking : intent.airbnb;
  if (!kind) return refuse(channel, "NO_CHANNEL_TYPE", `${ch} n'a pas de type de promotion équivalent à « ${intent.label.toLowerCase()} » dans le registre de cumul : rien n'est proposé plutôt que d'en deviner un.`);
  const def = promoKind(channel, kind);
  if (!def) return refuse(channel, "NOT_IN_REGISTRY", `Le type « ${kind} » est absent du registre de cumul de ${ch} : l'éligibilité n'est pas établie.`);
  const price = i.publishedNightlyCents[channel];
  if (!price) return refuse(channel, "MISSING_DATA", `Le prix publié sur ${ch} n'est pas renseigné.`);
  const miss = missingEconomics(ctx.model, channel);
  if (miss.length) return refuse(channel, "MISSING_DATA", `Il manque au modèle économique : ${miss.join(", ")}. Sans coûts, aucun plancher ne peut être vérifié.`);
  if (ctx.maxDiscountStackPct === null || !Number.isFinite(ctx.maxDiscountStackPct)) return refuse(channel, "MISSING_DATA", "Le plafond de cumul des remises de la stratégie est inconnu : sans lui, aucune promotion n'est proposée.");

  const windowNights = nightsBetween(i.stayFrom, i.stayTo);
  const minLos = i.minLos;
  if (minLos !== null && minLos > windowNights) return refuse(channel, "WINDOW_TOO_SHORT", `La fenêtre de séjours (${windowNights} nuit${windowNights > 1 ? "s" : ""}) est plus courte que le séjour minimal (${minLos} nuits).`);
  const nights = Math.min(minLos ?? REFERENCE_NIGHTS, windowNights);

  const overlapping = ctx.active.filter((a) => a.channel === channel && overlapsWindow(a, i.stayFrom, i.stayTo));
  const same = overlapping.find((a) => a.kind.toUpperCase() === kind);
  if (same) return refuse(channel, "ALREADY_ACTIVE", `« ${same.label} » (même type, ${same.discountPct} %) est déjà active sur ces séjours (si elle ne vise qu'une autre annonce, terminez-la ou modifiez-la dans le registre) : deux remises visant le même signal ne sont pas activées ensemble (blueprint §10.4). Modifiez-la ou terminez-la d'abord.`);
  const exclusive = overlapping.find((a) => ruleFor(channel, kind, a.kind).status === "EXCLUSIVE");
  if (exclusive) return refuse(channel, "EXCLUSIVE_WITH_ACTIVE", `${ch} n'applique qu'une seule de ces remises à une réservation, et « ${exclusive.label} » est déjà active (peut-être sur une autre annonce : vérifiez le registre) : la nouvelle ne changerait rien de sûr. Terminez l'ancienne si vous la remplacez.`);

  const isLos = kind === "LOS";
  const others: SimPromo[] = overlapping.map((a) => ({ kind: a.kind, label: a.label, discountPct: a.discountPct }));
  const run = (pct: number): Simulation => simulate({
    model: ctx.model, channel, nights, stayFrom: i.stayFrom, publishedNightlyCents: price,
    losDiscountPct: isLos ? pct : undefined, promos: isLos ? others : [...others, { kind, label: def.label, discountPct: pct }],
    maxDiscountStackPct: ctx.maxDiscountStackPct!, registryStale: !!ctx.registryStale[channel],
  });
  // La plus grande remise qui respecte les DEUX planchers (absolu et stratégique) et le plafond de cumul, par pas de 0,5 point.
  // Le simulateur ne compare au plancher stratégique que les nuits qui suivent le début de la fenêtre : on exige en plus le plancher le plus
  // exigeant de TOUTES les saisons que la fenêtre traverse (règle de l'auditeur : le plancher le plus exigeant s'applique).
  const windowFloor = strategyFloorWindow(ctx.model, channel, nights, i.stayFrom, i.stayTo).floor;
  const safe = (s: Simulation) => s.result.soldNightlyCents >= windowFloor && !s.reasons.some((r) => (r.code === "HARD_FLOOR" || r.code === "STRATEGY_FLOOR" || r.code === "DISCOUNT_STACK") && r.outcome !== "PASS");
  let pick: { pct: number; sim: Simulation } | null = null;
  // on part du plus grand pas de 0,5 qui ne dépasse pas la remise maximale saisie
  for (let pct = Math.floor(i.maxDiscountPct / STEP + 1e-9) * STEP; pct >= 1 - 1e-9; pct = Math.round((pct - STEP) * 10) / 10) {
    const sim = run(pct);
    if (safe(sim)) { pick = { pct, sim }; break; }
  }
  if (!pick) {
    const worst = run(1);
    const cap = worst.reasons.find((r) => r.code === "DISCOUNT_STACK" && r.outcome !== "PASS");
    if (cap) return refuse(channel, "STACK_CAP", `Même une remise de 1 % dépasse le plafond de cumul des remises de la stratégie sur ${ch}. ${cap.detail} Terminez une promotion en place ou relevez le plafond dans la stratégie.`);
    const why = worst.reasons.find((r) => r.outcome === "FAIL" || r.outcome === "WARN");
    return refuse(channel, "FLOOR", `Aucune remise de 1 % à ${i.maxDiscountPct} % ne respecte les planchers sur ${ch}${windowFloor > worst.floors.strategyCents ? " (une saison de la fenêtre a un plancher plus haut)" : ""}. ${why?.detail ?? ""} Le prix publié est déjà trop bas pour une promotion.`.trim());
  }

  const humanReasons = pick.sim.reasons.filter((r) => r.outcome === "HUMAN").map((r) => r.detail);
  if (ctx.registryEmpty?.[channel]) humanReasons.push(`Aucune promotion n'est inscrite au registre ${ch} de ce logement. Le registre est tenu à la main : vérifiez dans l'extranet qu'aucune autre promotion ne s'applique à ces séjours, puis déclarez-les.`);
  const stack = evaluateStacking(channel, [...others.map((p, n) => ({ id: `a${n}`, kind: p.kind, label: p.label })), { id: "new", kind, label: def.label }]);
  const notes: string[] = [];
  if (pick.pct < i.maxDiscountPct) notes.push(`Remise ramenée de ${i.maxDiscountPct} % à ${pick.pct} % : au-delà, le prix vendu passerait sous un plancher.`);
  const advanceMode = i.intent === "STIMULATE_NEAR_TERM_DEMAND" ? "AT_MOST" : i.intent === "STIMULATE_EARLY_BOOKING" ? "AT_LEAST" : null;
  const settings: PromotionSettings = {
    channel, kind, kindLabel: def.label, discountPct: pick.pct, stayFrom: i.stayFrom, stayTo: i.stayTo,
    minLos: minLos, advanceDays: advanceMode ? i.advanceDays : null, advanceMode, audience: audienceOfKind(kind),
  };
  return { channel, status: humanReasons.length ? "NEEDS_HUMAN" : "COMPILED", settings, simulation: pick.sim, humanReasons, notes };
}

/** Compile l'intention pour chaque canal demandé. Aucun canal n'en bloque un autre : chacun a son propre résultat. */
export function compilePromotions(input: CompileInput, ctx: CompileContext): CompileResult {
  return { intent: input.intent, pricelabsNote: INTENTS[input.intent].pricelabs, outcomes: input.channels.map((c) => compileChannel(input, ctx, c)) };
}

/** Texte court de la fenêtre de réservation, pour l'écran et le guide. */
export function advanceText(s: Pick<PromotionSettings, "advanceDays" | "advanceMode">): string | null {
  if (!s.advanceDays || !s.advanceMode) return null;
  return s.advanceMode === "AT_MOST" ? `Réservable au plus ${s.advanceDays} jour${s.advanceDays > 1 ? "s" : ""} avant l'arrivée` : `Réservable au moins ${s.advanceDays} jours avant l'arrivée`;
}
export const windowText = (s: Pick<PromotionSettings, "stayFrom" | "stayTo">) => `Séjours du ${fr(s.stayFrom)} au ${fr(addDays(s.stayTo, -1))} inclus`;
