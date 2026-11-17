import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { todayISO } from "../dates";
import { AWAITING_GRID_HOURS, awaitingGrid, backoffMinutes, computeCadence, marketOccupancy30, rollMarketRef, type Cadence, type MarketRef } from "../engine/cadence";
import { loadEngineInput } from "./review";

const { properties, opportunities } = schema;

type Fail = { n: number; at: string | null };
/** État du rythme de suivi enregistré sur le logement (colonne `cadence`). */
export type CadenceState = Cadence & {
  computedAt: string;
  lastReviewAt: string | null;
  /** La dernière revue n'a rien pu ouvrir faute de calendrier ou de modèle économique. */
  blocked: boolean;
  marketRef: MarketRef | null;
  failures: { pl: Fail; sh: Fail };
  /** PriceLabs n'avait pas encore refait son calcul nocturne à la dernière lecture : relecture rapprochée. */
  awaitingGrid: boolean;
};

const HOUR = 3600000;
const failure = (prev: Fail | undefined, ls: { ok?: boolean; at?: string } | null | undefined): Fail =>
  !ls || ls.ok !== false ? { n: 0, at: null } : prev?.at === ls.at ? prev! : { n: (prev?.n ?? 0) + 1, at: ls.at ?? null };
/** Échéance suivante d'une lecture : dernier passage + intervalle si elle a réussi, + délai croissant si elle a échoué. null = à faire maintenant. */
const nextRead = (ls: { ok?: boolean; at?: string } | null | undefined, everyH: number, f: Fail): Date | null =>
  !ls?.at ? null : new Date(+new Date(ls.at) + (ls.ok === false ? backoffMinutes(f.n) * 60000 : everyH * HOUR));

/**
 * Recalcule le rythme de suivi d'un logement à partir de ses données courantes et replanifie ses trois échéances
 * (réservations SuperHote, prix et marché PriceLabs, revue). Appelé après chaque lecture et chaque revue.
 */
export async function refreshCadence(tenantId: string, propertyId: string, opts: { reviewed?: { blocked: boolean } } = {}, now = new Date()): Promise<CadenceState | null> {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) return null;
  const today = todayISO(now);
  const input = await loadEngineInput(tenantId, p.id, today, now);
  if (!input) return null;
  const deferred = await db.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.propertyId, p.id), eq(opportunities.status, "DEFERRED")));
  const prev = (p.cadence ?? {}) as Partial<CadenceState>;
  const hasPl = !p.isDemo && !!p.pricelabs?.listingId, hasSh = !p.isDemo && !!p.superhote?.rentalId;
  const marketRef = rollMarketRef(prev.marketRef, marketOccupancy30(input.days, today), now);
  const c = computeCadence({ today, days: input.days, resas: input.resas, followUps: input.activeRanges.length + deferred.length, marketDeltaPts: marketRef?.deltaPts ?? null, isDemo: p.isDemo, hasSuperhote: hasSh });

  const pl = p.pricelabs?.lastSync, sh = p.superhote?.lastSync;
  const failures = { pl: failure(prev.failures?.pl, hasPl ? pl : null), sh: failure(prev.failures?.sh, hasSh ? sh : null) };
  const waiting = hasPl && pl?.ok !== false && awaitingGrid(pl?.gridRefreshedAt, pl?.at);
  // sans SuperHote, PriceLabs porte aussi les réservations : sa lecture suit le plus court des deux rythmes
  const pricesEveryH = waiting ? AWAITING_GRID_HOURS : hasSh ? c.pricesEveryH : Math.min(c.pricesEveryH, c.reservationsEveryH);
  const lastReviewAt = opts.reviewed ? now.toISOString() : prev.lastReviewAt ?? null;

  const state: CadenceState = {
    ...c, pricesEveryH: hasSh ? c.pricesEveryH : Math.min(c.pricesEveryH, c.reservationsEveryH),
    computedAt: now.toISOString(), lastReviewAt, blocked: opts.reviewed ? opts.reviewed.blocked : prev.blocked ?? false, marketRef, failures, awaitingGrid: waiting,
  };
  await db.update(properties).set({
    cadence: state,
    nextReservationsAt: hasSh ? nextRead(sh, c.reservationsEveryH, failures.sh) : null,
    nextPricesAt: hasPl ? nextRead(pl, pricesEveryH, failures.pl) : null,
    nextReviewAt: lastReviewAt ? new Date(+new Date(lastReviewAt) + c.reviewEveryH * HOUR) : null,
  }).where(eq(properties.id, p.id));
  return state;
}
