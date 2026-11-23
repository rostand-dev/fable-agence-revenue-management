import { and, eq, inArray } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import type { ISODate } from "../dates";
import { PriceLabsError, priceLabsFor } from "../integrations/pricelabs";
import { mapPrices } from "../integrations/pricelabs-map";
import { checkPreconditions } from "../integrations/pricelabs-preconditions";
import { mapOverride, planWrite, requestHash, priceLabsWriterFor, type WritePlan } from "../integrations/pricelabs-write";
import type { ListingLimits, PriceLabsWritePort, RemoteOverride, WriteReceipt } from "../integrations/pricelabs-write-port";
import { decryptSecret } from "../secret";

/**
 * Écriture PriceLabs d'une action approuvée (épic 9, US-090). Trois temps, tous « échouer fermé » :
 * 1. `preparePriceLabsWrite` : relire l'état réel chez PriceLabs et calculer ce qu'il faut écrire. Un refus ici laisse l'action APPROUVÉE, rien n'est envoyé.
 * 2. `sendPriceLabsWrite` : inscrire la tentative au journal (clé d'idempotence unique), envoyer, relire, comparer. Aucune écriture sans ligne de journal ;
 *    une écriture non confirmée par la relecture est un échec, jamais un succès supposé.
 * 3. `readBackPriceLabsWrite` : la vérification demandée plus tard (`verify()`), même comparaison.
 * Aucune clé API n'est écrite dans le journal, ni dans le reçu, ni dans les messages.
 */
const { externalWrites, properties, calendarDays } = schema;

/** Refus ou échec lisible : le message est affiché tel quel et inscrit au journal d'audit. */
export class WriteError extends Error {
  /** `sent` : la requête d'écriture est partie (ou a pu partir) : PriceLabs a peut-être été modifié, même si l'on n'en a pas la preuve. */
  constructor(message: string, readonly code: "PREPARE" | "PRECONDITION" | "SEND" | "CONFIRM" | "IDEMPOTENT" = "PREPARE", readonly sent = false, readonly writeId: string | null = null) { super(message); }
}

/** État réel d'une annonce, en centimes. `limits` = prix minimum, de base, maximum ; `prices` = grille sur les dates demandées ; `overrides` = prix datés en vigueur. */
export type RemoteState = {
  readAt: string;
  pushEnabled: boolean | null;
  currency: string | null;
  limits: { minCents: number | null; baseCents: number | null; maxCents: number | null };
  prices: Record<string, number | null>;
  overrides: RemoteOverride[];
};
type Prop = typeof properties.$inferSelect;
export type Target = { apiKey: string; listingId: string; pms: string };

/** Annonce PriceLabs rattachée au logement et clé API déchiffrée. */
export function targetOf(p: Pick<Prop, "pricelabs" | "isDemo" | "name">): Target {
  const pl = p.pricelabs;
  if (p.isDemo) throw new WriteError("Un logement de démonstration n'écrit jamais chez PriceLabs.");
  if (!pl?.apiKeyEnc || !pl.listingId || !pl.pms) throw new WriteError("Aucune annonce PriceLabs n'est rattachée à ce logement : écriture impossible.");
  let apiKey: string;
  try { apiKey = decryptSecret(pl.apiKeyEnc); } catch { throw new WriteError("La clé PriceLabs enregistrée est illisible (APP_SECRET a changé ?) : saisissez-la de nouveau."); }
  return { apiKey, listingId: String(pl.listingId), pms: String(pl.pms) };
}

const msg = (e: unknown) => (e instanceof PriceLabsError || e instanceof WriteError ? e.message : "erreur technique pendant l'échange avec PriceLabs");
const minOf = (ds: string[]) => ds.reduce((a, b) => (b < a ? b : a));
const maxOf = (ds: string[]) => ds.reduce((a, b) => (b > a ? b : a));

/**
 * Relit l'annonce chez PriceLabs : limites, grille et prix datés sur `dates`. Échoue fermé : une lecture impossible ou illisible lève une erreur,
 * elle n'est jamais prise pour « rien à signaler ».
 */
export async function readRemoteState(t: Target, dates: string[], writer: PriceLabsWritePort = priceLabsWriterFor(t.apiKey)): Promise<RemoteState> {
  try {
    const reader = priceLabsFor(t.apiKey);
    const listing = (await reader.listListings()).find((l) => l.id === t.listingId && l.pms === t.pms);
    if (!listing) throw new WriteError("L'annonce rattachée n'existe plus sur le compte PriceLabs : écriture impossible.");
    let prices: Record<string, number | null> = {}, overrides: RemoteOverride[] = [];
    if (dates.length) {
      const from = minOf(dates) as ISODate, to = maxOf(dates) as ISODate;
      const item = await reader.getPrices(t.listingId, t.pms, from, to);
      for (const d of mapPrices(item)) if (d.date >= from && d.date <= to) prices[d.date] = d.priceCents;
      overrides = await writer.getOverrides(t.listingId, t.pms, from, to);
    }
    return { readAt: new Date().toISOString(), pushEnabled: listing.pushEnabled, currency: listing.currency, limits: { minCents: listing.minCents, baseCents: listing.baseCents, maxCents: listing.maxCents }, prices, overrides };
  } catch (e) {
    throw new WriteError(`Lecture de l'état PriceLabs impossible : ${msg(e)}`);
  }
}

/** Ce qui doit être vrai chez PriceLabs après l'écriture, comparé à l'état relu. Liste vide = conforme. */
export function mismatches(plan: Exclude<WritePlan, { kind: "UNSUPPORTED" }>, after: RemoteState): string[] {
  const out: string[] = [];
  if (plan.kind === "LISTING_LIMITS") {
    const want: [keyof ListingLimits, "minCents" | "baseCents" | "maxCents", string][] = [["minCents", "minCents", "prix minimum"], ["baseCents", "baseCents", "prix de base"], ["maxCents", "maxCents", "prix maximum"]];
    for (const [k, f, label] of want) if (plan.limits[k] !== undefined && after.limits[f] !== plan.limits[k]) out.push(`${label} relu : ${after.limits[f] === null ? "inconnu" : (after.limits[f]! / 100).toFixed(2)} € au lieu de ${(plan.limits[k]! / 100).toFixed(2)} €`);
  } else {
    for (const i of plan.items) {
      const o = after.overrides.find((x) => x.date === i.date);
      if (!o) out.push(`prix daté absent le ${i.date}`);
      else if (o.priceCents !== i.priceCents || (o.priceType ?? "fixed") !== "fixed") out.push(`prix daté du ${i.date} relu à ${o.priceCents === null ? "valeur inconnue" : (o.priceCents / 100).toFixed(2) + " €"} au lieu de ${(i.priceCents / 100).toFixed(2)} €`);
    }
  }
  return out;
}

/** Plan sans le cas « non écrivable » : c'est ce que l'on conserve et rejoue. */
export type SafePlan = Exclude<WritePlan, { kind: "UNSUPPORTED" }>;
export type PreparedWrite = { actionId: string; tenantId: string; propertyId: string; target: Target; plan: SafePlan; before: RemoteState };

/**
 * Temps 1. Relit l'état réel et calcule l'écriture. `a` : l'action (type, paramètres, identifiants). Lève `WriteError` si l'écriture est impossible ou douteuse.
 */
export async function preparePriceLabsWrite(p: Prop, a: { id: string; tenantId: string; type: string; parameters: Record<string, any> }): Promise<PreparedWrite> {
  const target = targetOf(p);
  // une écriture déjà engagée pour cette action prime sur toute précondition : l'état chez PriceLabs a justement pu changer à cause d'elle
  const [already] = await db.select({ id: externalWrites.id }).from(externalWrites).where(eq(externalWrites.idempotencyKey, `${a.id}:APPLY`));
  if (already) throw new WriteError("Une écriture PriceLabs a déjà été engagée pour cette action : aucun second envoi. Consultez son reçu ou le journal d'écriture.", "IDEMPOTENT");
  const dates: string[] = Array.isArray(a.parameters?.dates) ? a.parameters.dates : [];
  const needsDates = a.type === "PRICE_OVERRIDE" || a.type === "RULE_EXCLUSION";
  const before = await readRemoteState(target, needsDates ? dates : []);
  // la grille n'est lue que pour calculer un prix en % du prix courant ; les types à prix fixe n'en dépendent pas
  const needsGrid = needsDates && typeof a.parameters?.changePct === "number" && !(a.type === "RULE_EXCLUSION" || a.parameters?.restoresFloor);
  const state = needsGrid ? before : { ...before, prices: {} };
  const plan = planWrite({ type: a.type, parameters: a.parameters }, state.prices, { minCents: p.strategy?.minPriceCents ?? null, maxCents: p.strategy?.maxPriceCents ?? null });
  if (plan.kind === "UNSUPPORTED") throw new WriteError(plan.reason);
  // US-091 : l'état réel doit être celui sur lequel la simulation a été faite
  const localPrices: Record<string, number | null> = {};
  if (needsGrid && dates.length) for (const d of await db.select({ date: calendarDays.date, priceCents: calendarDays.priceCents }).from(calendarDays).where(and(eq(calendarDays.propertyId, p.id), inArray(calendarDays.date, dates)))) localPrices[d.date] = d.priceCents;
  const problems = checkPreconditions({ plan, type: a.type, parameters: a.parameters, remote: { limits: before.limits, pushEnabled: before.pushEnabled, prices: before.prices, overrides: before.overrides }, local: { prices: localPrices, baseCents: p.strategy?.basePriceCents ?? null, minCents: p.strategy?.minPriceCents ?? null } });
  if (problems.length) throw new WriteError(`Précondition non remplie, rien n'est écrit : ${problems.join(" ; ")}.`, "PRECONDITION");
  return { actionId: a.id, tenantId: a.tenantId, propertyId: p.id, target, plan, before };
}

/**
 * Instantané d'état (US-092) inscrit au journal : limites, devise, synchronisation, grille et prix datés bruts sur les dates visées. Aucun secret ni donnée de voyageur.
 * L'empreinte SHA-256 est recopiée dans l'exécution et dans l'événement d'audit (append-only) : une retouche de la ligne du journal serait visible en comparant les empreintes.
 */
const SENSITIVE_KEY = /mail|phone|guest|voyageur|name|nom|token|secret|key|password/i;
export function snapshotOf(s: RemoteState, dates: string[]) {
  const on = (d: string) => !dates.length || dates.includes(d);
  const prices: Record<string, number | null> = {};
  for (const d of dates) prices[d] = s.prices[d] ?? null;
  // Le retour arrière (US-093) remet le prix daté d'avant TEL QUEL : on conserve donc tous ses champs simples (texte, nombre, booléen, liste de valeurs simples),
  // sauf ceux dont le nom évoque une donnée personnelle ou un secret (jamais consignés), avec des longueurs bornées.
  const keep = (raw: Record<string, unknown>) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === "created_at" || k === "updated_at" || SENSITIVE_KEY.test(k)) continue;
      if (typeof v === "string") o[k] = v.slice(0, k === "reason" ? 500 : 200);
      else if (typeof v === "number" || typeof v === "boolean") o[k] = v;
      else if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) o[k] = v.slice(0, 50);
    }
    return o;
  };
  return { readAt: s.readAt, currency: s.currency, pushEnabled: s.pushEnabled, limits: s.limits, prices, overrides: s.overrides.filter((o) => on(o.date)).map((o) => keep(o.raw)) };
}
/** L'empreinte porte sur le CONTENU (date de lecture exclue) : deux lectures identiques donnent la même empreinte, une différence de contenu en change. */
const snapshotWithHash = (s: RemoteState, dates: string[]) => { const snap = snapshotOf(s, dates); const { readAt: _r, ...content } = snap; return { snap, hash: requestHash(content) }; };

const summaryOf = (s: RemoteState, dates: string[]) => ({
  readAt: s.readAt, limits: s.limits,
  overrides: s.overrides.filter((o) => !dates.length || dates.includes(o.date)).map((o) => ({ date: o.date, priceCents: o.priceCents, priceType: o.priceType, minStay: o.minStay })),
});
export type StateSummary = ReturnType<typeof summaryOf>;
export const planDates = (plan: SafePlan): string[] => (plan.kind === "OVERRIDES" ? plan.items.map((i) => i.date) : []);

export type WriteOutcome = {
  writeId: string;
  receipt: WriteReceipt;
  plan: SafePlan;
  /** État relu avant et après, limité aux dates concernées (jamais de clé, jamais de donnée de voyageur) */
  before: StateSummary;
  after: StateSummary;
  /** Dérogations qui existaient avant sur les dates visées, dans leur forme brute : de quoi tout remettre tel quel (retour arrière, US-093) */
  previousOverrides: Record<string, unknown>[];
  adapter: string;
  /** Empreintes SHA-256 des instantanés d'avant et d'après (US-092) */
  beforeHash: string;
  afterHash: string;
};

/** Ce qui est inscrit au journal AVANT l'envoi : le plan (l'instantané d'avant l'est dans la même ligne). Aucun secret. */
const planOf = (plan: SafePlan) => ({
  ...(plan.kind === "LISTING_LIMITS" ? { kind: plan.kind, limits: plan.limits } : { kind: plan.kind, items: plan.items }),
});
/** Erreur dont on est sûr qu'elle n'a rien modifié : refus clair de PriceLabs (4xx hors délai et limite de débit). Le reste (délai, coupure, 5xx) est ambigu. */
const certainFailure = (e: unknown) => e instanceof PriceLabsError && e.status !== null && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;

/**
 * Temps 2. Journal d'abord, envoi ensuite, relecture enfin.
 * - La ligne de journal porte une clé unique `<action>:APPLY` : une seconde tentative sur la même action est refusée (jamais deux envois).
 * - `recheck` est rappelée juste avant l'envoi (coupe-circuit, drapeau, état de l'action) : un changement survenu pendant la lecture est pris en compte.
 * - L'écriture n'est « confirmée » que si la relecture donne exactement les valeurs voulues.
 */
export async function sendPriceLabsWrite(w: PreparedWrite, opts: { recheck?: () => Promise<void> } = {}): Promise<WriteOutcome> {
  const writer = priceLabsWriterFor(w.target.apiKey);
  const beforeSnap = snapshotWithHash(w.before, planDates(w.plan));
  const writeId = newId("xw"), key = `${w.actionId}:APPLY`;
  const kind = w.plan.kind === "LISTING_LIMITS" ? "LISTING_LIMITS" : "OVERRIDES_SET";
  const inserted = await db.insert(externalWrites).values({ id: writeId, tenantId: w.tenantId, propertyId: w.propertyId, actionId: w.actionId, idempotencyKey: key, phase: "APPLY", kind, status: "PENDING", plan: planOf(w.plan), stateBefore: beforeSnap.snap, stateBeforeHash: beforeSnap.hash, adapter: writer.adapter })
    .onConflictDoNothing({ target: externalWrites.idempotencyKey }).returning({ id: externalWrites.id });
  if (!inserted.length) throw new WriteError("Une écriture PriceLabs a déjà été engagée pour cette action : aucun second envoi. Consultez son reçu ou lancez un retour arrière.", "IDEMPOTENT");
  const patch = async (set: Partial<typeof externalWrites.$inferInsert>): Promise<boolean> => { try { await db.update(externalWrites).set({ ...set, updatedAt: new Date() }).where(eq(externalWrites.id, writeId)); return true; } catch { return false; /* la consignation ne masque jamais l'erreur d'origine */ } };
  let sent = false;
  const fail = async (m: string, code: "SEND" | "CONFIRM", status: "FAILED" | "SENT" = "FAILED"): Promise<never> => { await patch({ status, error: m.slice(0, 500) }); throw new WriteError(m, code, sent, writeId); };

  const dates = planDates(w.plan);
  let receipt: WriteReceipt;
  try {
    await opts.recheck?.();
    sent = true; // dès cet appel, PriceLabs a pu être modifié
    receipt = w.plan.kind === "LISTING_LIMITS"
      ? await writer.setListingLimits(w.target.listingId, w.target.pms, w.plan.limits)
      : await writer.setPriceOverrides(w.target.listingId, w.target.pms, w.plan.items, { currency: w.before.currency, reason: "NuitSignal : action approuvée" });
  } catch (e) {
    if (e instanceof WriteError) { sent = false; return fail(e.message, "SEND"); } // refus interne (coupe-circuit…) avant tout envoi
    if (certainFailure(e)) return fail(`PriceLabs a refusé l'écriture : ${msg(e)} Rien n'a été modifié.`, "SEND");
    // délai dépassé, coupure ou panne : l'écriture a pu être appliquée. On ne le dit pas faux : le journal reste « envoyée » et l'état est à vérifier.
    return fail(`Réponse de PriceLabs incertaine (${msg(e)}) : l'écriture a peut-être été appliquée. Vérifiez dans PriceLabs avant toute nouvelle action ; les valeurs d'avant figurent dans le journal.`, "SEND", "SENT");
  }
  await patch({ status: "SENT", receipt });

  let after: RemoteState;
  try { after = await readRemoteState(w.target, dates, writer); }
  catch (e) { return fail(`Écriture envoyée mais non confirmée : ${msg(e)} Vérifiez dans PriceLabs.`, "CONFIRM", "SENT"); }
  const afterSnap = snapshotWithHash(after, dates);
  const bad = mismatches(w.plan, after);
  // conservé aussi quand la relecture ne retrouve pas l'écriture (preuve de ce qui s'est passé) ; l'état d'après, son empreinte et le statut final sont inscrits d'un seul coup
  const logged = await patch({ stateAfter: afterSnap.snap, stateAfterHash: afterSnap.hash, ...(bad.length ? {} : { status: "CONFIRMED" as const }) });
  if (bad.length) return fail(`Écriture envoyée mais la relecture ne la retrouve pas (${bad.join(" ; ")}). Vérifiez dans PriceLabs.`, "CONFIRM", "SENT");
  if (!logged) throw new WriteError("Écriture confirmée par relecture, mais son instantané d'après n'a pas pu être consigné au journal : vérifiez dans PriceLabs.", "CONFIRM", true, writeId);

  const previousOverrides = w.before.overrides.filter((o) => dates.includes(o.date)).map((o) => o.raw);
  return { writeId, receipt, plan: w.plan, before: summaryOf(w.before, dates), after: summaryOf(after, dates), previousOverrides, adapter: writer.adapter, beforeHash: beforeSnap.hash, afterHash: afterSnap.hash };
}

/**
 * Temps 3. Relit l'état réel et le compare à l'écriture enregistrée dans l'action (`execution.plan`). Renvoie les écarts ; liste vide = conforme.
 * Lève `WriteError` si la relecture est impossible : une vérification qui ne peut pas lire n'est pas une vérification réussie.
 */
export async function readBackPriceLabsWrite(p: Prop, plan: SafePlan): Promise<{ mismatches: string[]; state: StateSummary }> {
  const t = targetOf(p), dates = planDates(plan);
  const state = await readRemoteState(t, dates);
  return { mismatches: mismatches(plan, state), state: summaryOf(state, dates) };
}

/** Journal des écritures d'une action, plus récent d'abord. */
export async function writesOfAction(tenantId: string, actionId: string) {
  return db.select().from(externalWrites).where(and(eq(externalWrites.tenantId, tenantId), eq(externalWrites.actionId, actionId))).orderBy(externalWrites.createdAt);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// US-093 : retour arrière réel. Il rejoue l'écriture à l'envers à partir de l'instantané d'avant inscrit au journal : mêmes garde-fous que l'écriture
// (verrou, coupe-circuit rappelé juste avant chaque envoi, journal d'abord, relecture), et refus si l'état chez PriceLabs n'est plus celui que NuitSignal a écrit.
// ---------------------------------------------------------------------------------------------------------------------------------------------------
export type RollbackOutcome = { writeIds: string[]; receipts: WriteReceipt[]; noop: boolean; before: StateSummary; after: StateSummary; adapter: string; /** Valeurs de limites effectivement (re)posées chez PriceLabs, pour aligner la stratégie locale */ restoredLimits: ListingLimits };

/** Date d'un prix daté d'instantané, normalisée comme à la lecture (PriceLabs peut renvoyer une date horodatée). */
const dateOf = (o: unknown) => mapOverride(o)?.date;
const sameOverride = (a: RemoteOverride, b: RemoteOverride) => a.priceCents === b.priceCents && (a.priceType ?? "fixed") === (b.priceType ?? "fixed") && (a.minStay ?? null) === (b.minStay ?? null);
const limitLabel = (k: string) => (k === "minCents" ? "prix minimum" : k === "baseCents" ? "prix de base" : "prix maximum");
const eurs = (c: number | null | undefined) => (typeof c === "number" ? (c / 100).toFixed(2).replace(".", ",") + " €" : "inconnu");

/** Valeurs d'avant lisibles, pour remettre à la main quand le retour arrière automatique est impossible. */
export function manualRestoreText(w: { plan: unknown; stateBefore: unknown }): string {
  const plan = (w.plan ?? {}) as { kind?: string; limits?: Record<string, number>; items?: { date: string }[] };
  const b = (w.stateBefore ?? {}) as { limits?: Record<string, number | null>; overrides?: Record<string, any>[] };
  if (plan.kind === "LISTING_LIMITS") return Object.keys(plan.limits ?? {}).map((k) => `${limitLabel(k)} : ${eurs(b.limits?.[k])}`).join(" ; ") || "aucune valeur";
  return (plan.items ?? []).map((i) => { const o = (b.overrides ?? []).find((x) => dateOf(x) === i.date); return `${i.date} : ${o ? (o.price_type === "percent" ? o.price + " %" : eurs(Math.round(Number(o.price) * 100))) : "aucun prix daté (supprimer celui de NuitSignal)"}`; }).join(" ; ") || "aucune valeur";
}

/** L'écriture d'origine de l'action (phase APPLY) et les éventuels retours arrière déjà tentés. */
export async function rollbackContext(tenantId: string, actionId: string) {
  const rows = await writesOfAction(tenantId, actionId);
  return { apply: rows.find((r) => r.phase === "APPLY") ?? null, rollbacks: rows.filter((r) => r.phase === "ROLLBACK") };
}

/**
 * Retour arrière d'une écriture PriceLabs. `recheck` est rappelée juste avant chaque envoi (coupe-circuit, drapeau, verrou).
 * Lève `WriteError` avec un message lisible ; ne change jamais l'état de l'action (c'est `rollback()` qui le fait, après succès).
 */
export async function rollbackPriceLabsWrite(p: Prop, tenantId: string, actionId: string, opts: { recheck?: () => Promise<void> } = {}): Promise<RollbackOutcome> {
  const target = targetOf(p);
  const { apply, rollbacks } = await rollbackContext(tenantId, actionId);
  if (!apply || !apply.stateBefore) throw new WriteError("Aucun instantané d'avant n'est consigné pour cette action : retour arrière automatique impossible, remettez les valeurs à la main dans PriceLabs.");
  // Aucune ligne antérieure (confirmée, envoyée sans confirmation, restée « en préparation ») ne bloque : le calcul part TOUJOURS de l'état lu chez PriceLabs,
  // ce qui est déjà conforme est sauté. Une reprise après plantage, échec partiel ou clic en double est donc sûre ; deux envois simultanés sont écartés par la clé d'idempotence.
  const plan = apply.plan as { kind: string; limits?: Record<string, number>; items?: { date: string; priceCents: number }[] };
  const sb = apply.stateBefore as { limits: { minCents: number | null; baseCents: number | null; maxCents: number | null }; overrides?: Record<string, any>[] };
  const writer = priceLabsWriterFor(target.apiKey);
  const dates = plan.kind === "OVERRIDES" ? (plan.items ?? []).map((i) => i.date) : [];
  const now = await readRemoteState(target, dates, writer);

  // 1) ce qu'il faut remettre, et ce qui est déjà conforme
  type Step = { kind: "LISTING_LIMITS" | "OVERRIDES_RESTORE" | "OVERRIDES_DELETE"; run: () => Promise<WriteReceipt>; payload: unknown };
  const steps: Step[] = [], problems: string[] = [];
  if (plan.kind === "LISTING_LIMITS") {
    const back: ListingLimits = {};
    for (const [k, f] of [["minCents", "minCents"], ["baseCents", "baseCents"], ["maxCents", "maxCents"]] as const) {
      if (plan.limits?.[k] === undefined) continue;
      const was = sb.limits?.[f] ?? null, wrote_ = plan.limits[k], cur = now.limits[f];
      if (was === null) { problems.push(`la valeur d'avant du ${limitLabel(k)} est inconnue`); continue; }
      if (cur === was) continue; // déjà conforme
      if (cur !== wrote_) problems.push(`le ${limitLabel(k)} chez PriceLabs est ${eurs(cur)}, ni ${eurs(wrote_)} (écrit par NuitSignal) ni ${eurs(was)} (d'avant) : quelqu'un l'a modifié depuis`);
      else back[k] = was;
    }
    if (Object.keys(back).length) steps.push({ kind: "LISTING_LIMITS", payload: back, run: () => writer.setListingLimits(target.listingId, target.pms, back) });
  } else {
    const restore: RemoteOverride[] = [], remove: string[] = [];
    for (const it of plan.items ?? []) {
      const was = (sb.overrides ?? []).find((o) => dateOf(o) === it.date), cur = now.overrides.find((o) => o.date === it.date);
      const wasMapped = was ? mapOverride(was) : null;
      if (was && (!wasMapped || wasMapped.priceCents === null)) { problems.push(`le prix daté d'avant du ${it.date} est illisible`); continue; }
      if (!was && !cur) continue; // rien avant, rien maintenant
      if (wasMapped && cur && sameOverride(cur, wasMapped)) continue; // déjà conforme (prix, type et séjour minimum)
      if (!cur || cur.priceCents !== it.priceCents || (cur.priceType ?? "fixed") !== "fixed") { problems.push(`le prix daté du ${it.date} chez PriceLabs n'est plus celui écrit par NuitSignal (${eurs(it.priceCents)}) : quelqu'un l'a modifié depuis`); continue; }
      if (wasMapped) restore.push(wasMapped); else remove.push(it.date);
    }
    if (restore.length) steps.push({ kind: "OVERRIDES_RESTORE", payload: restore.map((o) => o.raw), run: () => writer.restoreOverrides(target.listingId, target.pms, restore) });
    if (remove.length) steps.push({ kind: "OVERRIDES_DELETE", payload: remove, run: () => writer.deleteOverrides(target.listingId, target.pms, remove as ISODate[]) });
  }
  if (problems.length) throw new WriteError(`Retour arrière automatique refusé, rien n'est écrit : ${problems.join(" ; ")}. Valeurs d'avant : ${manualRestoreText(apply)}.`, "PRECONDITION");
  const restoredLimits: ListingLimits = {};
  if (plan.kind === "LISTING_LIMITS") for (const k of ["minCents", "baseCents", "maxCents"] as const) if (plan.limits?.[k] !== undefined && typeof sb.limits?.[k] === "number") restoredLimits[k] = sb.limits[k] as number;
  if (!steps.length) return { writeIds: rollbacks.filter((r) => r.status === "CONFIRMED").map((r) => r.id), receipts: [], noop: true, before: summaryOf(now, dates), after: summaryOf(now, dates), adapter: writer.adapter, restoredLimits };

  // 2) journal d'abord, envoi ensuite, un pas à la fois ; le coupe-circuit est relu avant CHAQUE envoi
  const attempt = rollbacks.length + 1, writeIds: string[] = [], receipts: WriteReceipt[] = [];
  for (const [i, st] of steps.entries()) {
    const id = newId("xw"), key = `${actionId}:ROLLBACK:${attempt}:${i}`;
    const ins = await db.insert(externalWrites).values({ id, tenantId, propertyId: p.id, actionId, idempotencyKey: key, phase: "ROLLBACK", kind: st.kind, status: "PENDING", plan: { kind: st.kind, restores: st.payload } as any, stateBefore: snapshotOf(now, dates), stateBeforeHash: snapshotWithHash(now, dates).hash, adapter: writer.adapter }).onConflictDoNothing({ target: externalWrites.idempotencyKey }).returning({ id: externalWrites.id });
    if (!ins.length) throw new WriteError("Un retour arrière est déjà engagé pour cette action : aucun second envoi.", "IDEMPOTENT");
    const upd = async (set: Partial<typeof externalWrites.$inferInsert>) => { try { await db.update(externalWrites).set({ ...set, updatedAt: new Date() }).where(eq(externalWrites.id, id)); } catch { /* ne masque pas l'erreur d'origine */ } };
    writeIds.push(id);
    let rc: WriteReceipt;
    try {
      await opts.recheck?.();
      rc = await st.run();
    } catch (e) {
      const ambiguousErr = !(e instanceof WriteError) && !certainFailure(e);
      const m = e instanceof WriteError ? e.message : ambiguousErr ? `Réponse de PriceLabs incertaine (${msg(e)}) : le retour arrière a peut-être été appliqué. Vérifiez dans PriceLabs.` : `PriceLabs a refusé le retour arrière : ${msg(e)} Rien n'a été modifié par cette étape.`;
      await upd({ status: ambiguousErr ? "SENT" : "FAILED", error: m.slice(0, 500) });
      throw new WriteError(`${m}${receipts.length ? " Une étape précédente a déjà été envoyée : relancez le retour arrière, il reprend là où PriceLabs en est." : ""} Valeurs d'avant : ${manualRestoreText(apply)}.`, "SEND", ambiguousErr || receipts.length > 0, id);
    }
    await upd({ status: "SENT", receipt: rc });
    receipts.push(rc);
  }

  // 3) relecture : l'état doit être revenu à celui d'avant
  let after: RemoteState;
  try { after = await readRemoteState(target, dates, writer); }
  catch (e) { throw new WriteError(`Retour arrière envoyé mais non confirmé : ${msg(e)} Vérifiez dans PriceLabs. Valeurs d'avant : ${manualRestoreText(apply)}.`, "CONFIRM", true, writeIds[0] ?? null); }
  const bad: string[] = [];
  if (plan.kind === "LISTING_LIMITS") { for (const k of ["minCents", "baseCents", "maxCents"] as const) if (plan.limits?.[k] !== undefined && sb.limits?.[k] !== null && after.limits[k] !== sb.limits?.[k]) bad.push(`${limitLabel(k)} relu ${eurs(after.limits[k])} au lieu de ${eurs(sb.limits?.[k])}`); }
  else for (const it of plan.items ?? []) {
    const was = (sb.overrides ?? []).find((o) => dateOf(o) === it.date), wasMapped = was ? mapOverride(was) : null, cur = after.overrides.find((o) => o.date === it.date);
    if (wasMapped ? !cur || !sameOverride(cur, wasMapped) : !!cur) bad.push(`prix daté du ${it.date} non remis comme avant`);
  }
  const final = snapshotWithHash(after, dates);
  for (const id of writeIds) await db.update(externalWrites).set({ stateAfter: final.snap, stateAfterHash: final.hash, ...(bad.length ? {} : { status: "CONFIRMED" as const }), updatedAt: new Date() }).where(eq(externalWrites.id, id)).catch(() => {});
  if (bad.length) throw new WriteError(`Retour arrière envoyé mais la relecture ne le retrouve pas (${bad.join(" ; ")}). Vérifiez dans PriceLabs. Valeurs d'avant : ${manualRestoreText(apply)}.`, "CONFIRM", true, writeIds[0] ?? null);
  return { writeIds, receipts, noop: !steps.length, before: summaryOf(now, dates), after: summaryOf(after, dates), adapter: writer.adapter, restoredLimits };
}
