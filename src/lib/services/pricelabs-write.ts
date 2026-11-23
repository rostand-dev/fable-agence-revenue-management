import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import type { ISODate } from "../dates";
import { PriceLabsError, priceLabsFor } from "../integrations/pricelabs";
import { mapPrices } from "../integrations/pricelabs-map";
import { planWrite, priceLabsWriterFor, type WritePlan } from "../integrations/pricelabs-write";
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
const { externalWrites, properties } = schema;

/** Refus ou échec lisible : le message est affiché tel quel et inscrit au journal d'audit. */
export class WriteError extends Error {
  /** `sent` : la requête d'écriture est partie (ou a pu partir) : PriceLabs a peut-être été modifié, même si l'on n'en a pas la preuve. */
  constructor(message: string, readonly code: "PREPARE" | "SEND" | "CONFIRM" | "IDEMPOTENT" = "PREPARE", readonly sent = false, readonly writeId: string | null = null) { super(message); }
}

/** État réel d'une annonce, en centimes. `limits` = prix minimum, de base, maximum ; `prices` = grille sur les dates demandées ; `overrides` = prix datés en vigueur. */
export type RemoteState = {
  readAt: string;
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
    return { readAt: new Date().toISOString(), currency: listing.currency, limits: { minCents: listing.minCents, baseCents: listing.baseCents, maxCents: listing.maxCents }, prices, overrides };
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
  const dates: string[] = Array.isArray(a.parameters?.dates) ? a.parameters.dates : [];
  const needsDates = a.type === "PRICE_OVERRIDE" || a.type === "RULE_EXCLUSION";
  const before = await readRemoteState(target, needsDates ? dates : []);
  // la grille n'est lue que pour calculer un prix en % du prix courant ; les types à prix fixe n'en dépendent pas
  const needsGrid = needsDates && typeof a.parameters?.changePct === "number" && !(a.type === "RULE_EXCLUSION" || a.parameters?.restoresFloor);
  const state = needsGrid ? before : { ...before, prices: {} };
  const plan = planWrite({ type: a.type, parameters: a.parameters }, state.prices, { minCents: p.strategy?.minPriceCents ?? null, maxCents: p.strategy?.maxPriceCents ?? null });
  if (plan.kind === "UNSUPPORTED") throw new WriteError(plan.reason);
  return { actionId: a.id, tenantId: a.tenantId, propertyId: p.id, target, plan, before };
}

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
};

/** Ce qui est inscrit au journal AVANT l'envoi : le plan et l'état d'avant (de quoi tout remettre à la main si la suite échoue). Aucun secret. */
const planOf = (plan: SafePlan, before: RemoteState) => ({
  ...(plan.kind === "LISTING_LIMITS" ? { kind: plan.kind, limits: plan.limits } : { kind: plan.kind, items: plan.items }),
  before: { readAt: before.readAt, currency: before.currency, limits: before.limits, overrides: before.overrides.filter((o) => planDates(plan).includes(o.date)).map((o) => o.raw) },
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
  const writeId = newId("xw"), key = `${w.actionId}:APPLY`;
  const kind = w.plan.kind === "LISTING_LIMITS" ? "LISTING_LIMITS" : "OVERRIDES_SET";
  const inserted = await db.insert(externalWrites).values({ id: writeId, tenantId: w.tenantId, propertyId: w.propertyId, actionId: w.actionId, idempotencyKey: key, phase: "APPLY", kind, status: "PENDING", plan: planOf(w.plan, w.before), adapter: writer.adapter })
    .onConflictDoNothing({ target: externalWrites.idempotencyKey }).returning({ id: externalWrites.id });
  if (!inserted.length) throw new WriteError("Une écriture PriceLabs a déjà été engagée pour cette action : aucun second envoi. Consultez son reçu ou lancez un retour arrière.", "IDEMPOTENT");
  const patch = async (set: Partial<typeof externalWrites.$inferInsert>) => { try { await db.update(externalWrites).set({ ...set, updatedAt: new Date() }).where(eq(externalWrites.id, writeId)); } catch { /* la consignation ne masque jamais l'erreur d'origine */ } };
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
  const bad = mismatches(w.plan, after);
  if (bad.length) return fail(`Écriture envoyée mais la relecture ne la retrouve pas (${bad.join(" ; ")}). Vérifiez dans PriceLabs.`, "CONFIRM", "SENT");
  await patch({ status: "CONFIRMED" });

  const previousOverrides = w.before.overrides.filter((o) => dates.includes(o.date)).map((o) => o.raw);
  return { writeId, receipt, plan: w.plan, before: summaryOf(w.before, dates), after: summaryOf(after, dates), previousOverrides, adapter: writer.adapter };
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
