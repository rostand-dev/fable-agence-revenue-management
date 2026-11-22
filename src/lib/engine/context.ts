/**
 * Contexte d'une revue et utilitaires partagés par les règles de signal (`signals.ts`) et par les constructeurs d'opportunités (`detect.ts`).
 * Module pur, sans accès base.
 */
import { addDays, type ISODate } from "../dates";
import { percentileAfter, sellProbability } from "./demand";
import { cumulativeDiscountPct, simulateStack, UnknownEconomics } from "./economics";
import { leadTimes } from "./metrics";
import type { AuditContext } from "./audit";
import type { Channel, Day, EconomicModel, Promo, Resa, StackResult, Strategy } from "./types";
import { CHANNEL_LABEL } from "./types";

export type EngineInput = {
  today: ISODate;
  property: { id: string; name: string; isDemo: boolean };
  model: EconomicModel;
  strategy: Strategy;
  days: Day[];
  promos: Promo[];
  resas: Resa[];
  capabilities: Record<string, boolean>;
  /** Plages de dates couvertes par une action encore en observation */
  activeRanges: { from: ISODate; to: ISODate }[];
  now: Date;
  /**
   * Majoration SuperHote par canal, en % : prix du calendrier SuperHote (avant majoration) → prix affiché sur le canal.
   * `null` = majoration inconnue : le canal est exclu de la revue (jamais traité comme 0 %).
   * Absent = sans objet (prix de catalogue de démonstration, déjà au prix du canal).
   */
  markups?: Partial<Record<Channel, number | null>>;
  /** Origine du prix du calendrier : SuperHote fait foi dès qu'il est rattaché et lisible ; sinon prix recommandé PriceLabs. */
  priceSource?: "SUPERHOTE" | "PRICELABS";
};

export type Ctx = EngineInput & {
  byDate: Map<ISODate, Day>; channels: Channel[]; refChannel: Channel; refLos: number;
  lead: ReturnType<typeof leadTimes>; share: Record<string, number>; audit: AuditContext; claimed: Set<ISODate>;
  stale: Channel[];
};

export const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
export const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;

export function promosOn(promos: Promo[], channel: Channel, date: ISODate): Promo[] {
  return promos.filter((p) => p.channel === channel && (!p.stayFrom || p.stayFrom <= date) && (!p.stayTo || date < p.stayTo));
}
export function runs(dates: ISODate[]): ISODate[][] {
  const out: ISODate[][] = []; const s = [...dates].sort();
  for (const d of s) { const last = out[out.length - 1]; if (last && addDays(last[last.length - 1], 1) === d) last.push(d); else out.push([d]); }
  return out;
}
export const overlaps = (ctx: Ctx, from: ISODate, to: ISODate) => ctx.activeRanges.some((r) => r.from < to && from < r.to);

/** Multiplicateur du prix du calendrier vers le prix affiché sur le canal : 1 + majoration ÷ 100. Majoration inconnue = erreur, jamais 0 %. */
export function markupFactor(markups: EngineInput["markups"], channel: Channel): number {
  if (!markups) return 1;
  const m = markups[channel];
  if (m === undefined || m === null) throw new UnknownEconomics(["majoration " + CHANNEL_LABEL[channel]]);
  return 1 + m / 100;
}
/** `price` = prix du calendrier (avant majoration). Le prix publié sur le canal est price × (1 + majoration), puis remises, commission, coûts. */
export function stack(ctx: Ctx, channel: Channel, nights: number, price: number, promos: Promo[] | { label: string; discountPct: number }[]): StackResult {
  return simulateStack({ model: ctx.model, channel, nights, publishedNightlyCents: Math.round(price * markupFactor(ctx.markups, channel)), promos: promos.map((p) => ({ label: p.label, discountPct: p.discountPct })) });
}
export const markupPctOf = (ctx: Ctx, channel: Channel): number => (ctx.markups?.[channel] ?? 0);
export const fmtPctFr = (x: number) => (Math.round(x * 100) / 100).toString().replace(".", ",") + " %";
/** Espérance de contribution sur un ensemble de nuits libres, pour un prix et des remises donnés. */
export function expected(ctx: Ctx, dates: ISODate[], channel: Channel, priceFactor: number, promosFor: (d: ISODate) => { label: string; discountPct: number }[], los: number, demandFactor = 1): number | null {
  let total = 0;
  for (const date of dates) {
    const d = ctx.byDate.get(date);
    if (!d || d.priceCents === null || d.marketOccupancy === null || d.pricePercentile === null) return null;
    const promos = promosFor(date);
    // seul l'écart de remise par rapport à la situation actuelle déplace la position de prix
    const promoDelta = cumulativeDiscountPct(promos.map((p) => p.discountPct)) - cumulativeDiscountPct(promosOn(ctx.promos, channel, date).map((p) => p.discountPct));
    const effChange = (priceFactor - 1) * 100 - promoDelta * (ctx.share[channel] ?? 0.5);
    const p = sellProbability(Math.min(0.98, d.marketOccupancy * demandFactor), percentileAfter(d.pricePercentile, effChange));
    total += p * stack(ctx, channel, los, d.priceCents * priceFactor, promos).contributionPerNightCents;
  }
  return Math.round(total);
}
export function avgDay(ctx: Ctx, dates: ISODate[]) {
  const ds = dates.map((d) => ctx.byDate.get(d)!).filter(Boolean);
  const num = (f: (d: Day) => number | null) => { const xs = ds.map(f).filter((x): x is number => x !== null); return xs.length ? avg(xs) : null; };
  return { price: num((d) => d.priceCents), occ: num((d) => d.marketOccupancy), pctl: num((d) => d.pricePercentile), minStay: num((d) => d.minStay) };
}
