/**
 * Règles de signal (blueprint §7.2, §9.5, US-060). Une règle de signal ne décide rien : elle observe, compare à un seuil du catalogue
 * (`playbooks.ts`) et dit « ce signal est présent, voici les mesures et les nuits concernées ». Le diagnostic, les options et l'audit
 * sont construits ensuite (`detect.ts`) ; l'ouverture du dossier est décidée par le contrôleur (US-061).
 *
 * Module pur : aucun accès base, aucune horloge (la date et l'heure viennent du contexte). Même contexte, mêmes signaux.
 * Une donnée inconnue ne déclenche jamais un signal (« l'absence de donnée n'est pas égale à zéro », principe 7 du blueprint).
 *
 * Les règles marquent les nuits qu'elles traitent dans `ctx.claimed` pour que le playbook suivant ne propose pas une seconde action
 * sur les mêmes nuits : l'ordre d'évaluation (`SIGNAL_RULES`) est donc fixé et fait partie du contrat.
 */
import { addDays, diffDays, type ISODate } from "../dates";
import { avgDay, promosOn, runs, stack, type Ctx } from "./context";
import { hardFloorCents } from "./economics";
import { markupFactor } from "./context";
import { PLAYBOOKS, threshold, type PlaybookCode } from "./playbooks";
import { strategyFloorOver } from "./seasons";
import { cancellationStats } from "./history";
import { WINDOWS, type WindowStat } from "./metrics";
import type { Channel, SignalMeasure, SignalSummary, StackResult } from "./types";

export type Signal<P = unknown> = {
  playbook: PlaybookCode;
  /** Code stable du déclencheur (ex. FLOOR_BREACH) ; le code de raison final du dossier peut le préciser (PB-01). */
  trigger: string;
  /** Clé de dédoublonnage d'un jour à l'autre (fenêtre, canal…) ; à défaut, la première nuit. */
  dedupe: string | null;
  channel: Channel | null;
  from: ISODate;
  to: ISODate;
  /** Nuits concernées (peut être vide : PB-10 porte sur une donnée, pas sur des nuits). */
  dates: ISODate[];
  measures: SignalMeasure[];
  /** Ce que le constructeur d'opportunité a besoin de savoir, déjà calculé. */
  payload: P;
};

const m = (key: string, label: string, measured: number | string | null, thr: number | null, op: SignalMeasure["op"], unit: string): SignalMeasure => ({ key, label, measured, threshold: thr, op, unit });
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Fenêtre canonique (§7.3) qui contient une date : D0_7…D61_90, ou D90_PLUS au-delà. */
export function horizonOf(today: ISODate, date: ISODate): string {
  const o = diffDays(date, today);
  return WINDOWS.find((w) => o >= w.from && o <= w.to)?.key ?? (o > 90 ? "D90_PLUS" : "D0_7");
}

/** Version rangeable en base et affichable d'un signal : sans la charge utile interne des constructeurs. */
export function summarize(s: Signal<unknown>, today: ISODate): SignalSummary {
  return {
    playbook: s.playbook, trigger: s.trigger, horizon: horizonOf(today, s.from), channel: s.channel, from: s.from, to: s.to, nights: s.dates.length,
    measures: s.measures, requiredData: [...PLAYBOOKS[s.playbook].requiredData],
  };
}

/* ------------------------------------------------------------------ PB-06 */
export type FloorBreachPayload = { run: ISODate[]; channel: Channel; los: number };
export function detectFloorBreach(ctx: Ctx): Signal<FloorBreachPayload>[] {
  const out: Signal<FloorBreachPayload>[] = [];
  const los = Math.max(ctx.strategy.minStay ?? threshold("PB-06", "minStayFloor"), threshold("PB-06", "minStayFloor"));
  const hit: { date: ISODate; channel: Channel }[] = [];
  for (const d of ctx.days) {
    if (d.state !== "FREE" || d.priceCents === null) continue;
    for (const ch of ctx.channels) {
      const sold = stack(ctx, ch, los, d.priceCents, promosOn(ctx.promos, ch, d.date)).soldNightlyCents;
      if (sold < hardFloorCents(ctx.model, ch, los)) { hit.push({ date: d.date, channel: ch }); break; }
    }
  }
  for (const run of runs(hit.map((h) => h.date))) {
    const channel = hit.find((h) => h.date === run[0])!.channel;
    const from = run[0], to = addDays(run[run.length - 1], 1);
    run.forEach((d) => ctx.claimed.add(d));
    const price = avgDay(ctx, run).price!;
    const sold = stack(ctx, channel, los, price, promosOn(ctx.promos, channel, run[0])).soldNightlyCents;
    out.push({
      playbook: "PB-06", trigger: "FLOOR_BREACH", dedupe: null, channel, from, to, dates: run,
      measures: [m("soldNightlyCents", "Prix vendu net simulé par nuit", sold, hardFloorCents(ctx.model, channel, los), "<", "cents")],
      payload: { run, channel, los },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-13 */
export type MinPricePayload = { channel: Channel; los: number; minCents: number; hardCents: number; needed: number; current: StackResult };
export function detectMinPriceBelowFloor(ctx: Ctx): Signal<MinPricePayload>[] {
  const min = ctx.strategy.minPriceCents;
  if (!min || min <= 0 || ctx.channels.length === 0) return [];
  const los = Math.max(ctx.strategy.minStay ?? 2, 2);
  const rows = ctx.channels.map((ch) => {
    const cur = stack(ctx, ch, los, min, []);
    const hard = hardFloorCents(ctx.model, ch, los);
    return { ch, cur, hard, need: Math.ceil(hard / markupFactor(ctx.markups, ch) / 100) * 100 };
  });
  const bad = rows.filter((r) => r.cur.soldNightlyCents < r.hard).sort((a, b) => b.need - a.need);
  if (!bad.length) return [];
  const w = bad[0];
  return [{
    playbook: "PB-13", trigger: "MIN_PRICE_BELOW_FLOOR", dedupe: "min", channel: w.ch, from: ctx.today, to: addDays(ctx.today, 90), dates: [],
    measures: [m("soldAtMinCents", "Prix vendu au minimum PriceLabs", w.cur.soldNightlyCents, w.hard, "<", "cents")],
    payload: { channel: w.ch, los, minCents: min, hardCents: w.hard, needed: w.need, current: w.cur },
  }];
}

/* ------------------------------------------------------------------ PB-05 */
export type StackRiskPayload = { channel: Channel; run: ISODate[]; los: number };
export function detectStackRisk(ctx: Ctx): Signal<StackRiskPayload>[] {
  const out: Signal<StackRiskPayload>[] = [];
  const los = Math.max(ctx.refLos, 2);
  const minPromos = threshold("PB-05", "minPromotions"), minRun = threshold("PB-05", "minRunNights");
  for (const channel of ctx.channels) {
    const dates = ctx.days.filter((d) => {
      if (d.state !== "FREE" || d.priceCents === null || ctx.claimed.has(d.date)) return false;
      const ps = promosOn(ctx.promos, channel, d.date);
      if (ps.length < minPromos) return false;
      const s = stack(ctx, channel, los, d.priceCents, ps);
      return s.cumulativeDiscountPct > ctx.strategy.maxDiscountStackPct || s.soldNightlyCents < strategyFloorOver(ctx.model, channel, los, d.date);
    }).map((d) => d.date);
    for (const run of runs(dates).filter((r) => r.length >= minRun)) {
      const from = run[0], to = addDays(run[run.length - 1], 1);
      run.forEach((d) => ctx.claimed.add(d));
      const cur = stack(ctx, channel, los, avgDay(ctx, run).price!, promosOn(ctx.promos, channel, run[0]));
      out.push({
        playbook: "PB-05", trigger: "DISCOUNT_STACK_RISK", dedupe: null, channel, from, to, dates: run,
        measures: [
          m("cumulativeDiscountPct", "Cumul des remises", round2(cur.cumulativeDiscountPct), ctx.strategy.maxDiscountStackPct, ">", "%"),
          m("soldNightlyCents", "Prix vendu net simulé par nuit", cur.soldNightlyCents, strategyFloorOver(ctx.model, channel, los, from, to), "<", "cents"),
        ],
        payload: { channel, run, los },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ PB-03 */
export type OrphanGapPayload = { run: ISODate[]; minStay: number; channel: Channel; price: number };
export function detectOrphanGap(ctx: Ctx): Signal<OrphanGapPayload>[] {
  const out: Signal<OrphanGapPayload>[] = [];
  const maxGap = threshold("PB-03", "maxGapNights"), minLead = threshold("PB-03", "minLeadDays"), maxLead = threshold("PB-03", "maxLeadDays");
  const free = ctx.days.filter((d) => d.state === "FREE" && !ctx.claimed.has(d.date) && diffDays(d.date, ctx.today) >= minLead && diffDays(d.date, ctx.today) <= maxLead).map((d) => d.date);
  for (const run of runs(free)) {
    if (run.length > maxGap) continue;
    const before = ctx.byDate.get(addDays(run[0], -1)), after = ctx.byDate.get(addDays(run[run.length - 1], 1));
    if (!before || !after || before.state === "FREE" || after.state === "FREE") continue;
    const a = avgDay(ctx, run);
    const minStay = Math.round(a.minStay ?? ctx.strategy.minStay ?? 0);
    if (!minStay || minStay <= run.length || a.price === null) continue;
    run.forEach((d) => ctx.claimed.add(d));
    out.push({
      playbook: "PB-03", trigger: "ORPHAN_GAP", dedupe: null, channel: ctx.refChannel, from: run[0], to: addDays(run[run.length - 1], 1), dates: run,
      measures: [m("gapNights", "Nuits du trou", run.length, maxGap, "<=", "nuits"), m("minimumStay", "Séjour minimum en vigueur", minStay, run.length, ">", "nuits")],
      payload: { run, minStay, channel: ctx.refChannel, price: a.price },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-07 */
export type EventUpliftPayload = { run: ISODate[] };
export function detectEventUplift(ctx: Ctx): Signal<EventUpliftPayload>[] {
  const out: Signal<EventUpliftPayload>[] = [];
  const occ = threshold("PB-07", "marketOccupancy"), pctl = threshold("PB-07", "maxPricePercentile");
  const dates = ctx.days.filter((d) => d.state === "FREE" && d.event && !ctx.claimed.has(d.date) && (d.marketOccupancy ?? 0) >= occ && d.pricePercentile !== null && d.pricePercentile <= pctl && d.priceCents !== null).map((d) => d.date);
  for (const run of runs(dates)) {
    run.forEach((d) => ctx.claimed.add(d));
    const a = avgDay(ctx, run);
    out.push({
      playbook: "PB-07", trigger: "EVENT_UPLIFT", dedupe: null, channel: null, from: run[0], to: addDays(run[run.length - 1], 1), dates: run,
      measures: [m("marketOccupancy", "Occupation du marché", a.occ === null ? null : round2(a.occ), occ, ">=", "ratio"), m("pricePercentile", "Position de prix", a.pctl === null ? null : Math.round(a.pctl), pctl, "<=", "percentile")],
      payload: { run },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-02 */
/** Fenêtre dont l'écart au marché est connu : l'occupation du logement et celle du marché le sont donc aussi. */
export type KnownWindow = Omit<WindowStat, "gap" | "occupancy" | "marketOccupancy"> & { gap: number; occupancy: number; marketOccupancy: number };
const known = (w: WindowStat) => w as KnownWindow;
export type PaceHighPayload = { window: KnownWindow; horizonFree: ISODate[]; winFree: ISODate[] };
export function detectPaceHigh(ctx: Ctx, stats: WindowStat[]): Signal<PaceHighPayload>[] {
  const gapMin = threshold("PB-02", "paceGap"), occMin = threshold("PB-02", "minOccupancy"), freeMin = threshold("PB-02", "minFreeNights");
  for (const w of stats.slice(3)) {
    if (w.gap === null || w.occupancy === null || w.gap < gapMin || w.occupancy < occMin) continue;
    const horizonFree = ctx.days.filter((d) => d.state === "FREE" && d.date >= w.from && !ctx.claimed.has(d.date) && d.priceCents !== null).map((d) => d.date);
    const winFree = w.freeDates.filter((d) => !ctx.claimed.has(d));
    if (horizonFree.length < freeMin) continue;
    horizonFree.forEach((d) => ctx.claimed.add(d));
    return [{
      playbook: "PB-02", trigger: "PACE_ABOVE_MARKET", dedupe: "base", channel: ctx.refChannel, from: w.from, to: w.to, dates: horizonFree,
      measures: [m("paceGap", "Avance sur le marché", round2(w.gap), gapMin, ">=", "points"), m("occupancy", "Occupation du logement", round2(w.occupancy), occMin, ">=", "ratio"), m("freeNights", "Nuits libres à l'horizon", horizonFree.length, freeMin, ">=", "nuits")],
      payload: { window: known(w), horizonFree, winFree },
    }];
    // une seule hypothèse structurante à la fois par logement : la première fenêtre qui répond suffit
  }
  return [];
}

/* ------------------------------------------------------------------ PB-01 */
export type PaceLowPayload = { window: KnownWindow; free: ISODate[] };
export function detectPaceLow(ctx: Ctx, stats: WindowStat[]): Signal<PaceLowPayload>[] {
  const out: Signal<PaceLowPayload>[] = [];
  const gapMax = threshold("PB-01", "paceGap"), freeMin = threshold("PB-01", "minFreeNights");
  for (const w of stats.slice(1)) {
    if (w.gap === null || w.gap > gapMax) continue;
    const free = w.freeDates.filter((d) => !ctx.claimed.has(d));
    if (free.length < freeMin) continue;
    const a = avgDay(ctx, free);
    if (a.price === null || a.occ === null) continue;
    out.push({
      playbook: "PB-01", trigger: "PACE_BELOW_MARKET", dedupe: w.key, channel: ctx.refChannel, from: w.from, to: w.to, dates: free,
      measures: [m("paceGap", "Écart d'occupation au marché", round2(w.gap), gapMax, "<=", "points"), m("freeNights", "Nuits libres", free.length, freeMin, ">=", "nuits")],
      payload: { window: known(w), free },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-04 */
export type ChannelGapPayload = { channel: Channel; onBooksShare: number; historicalShare: number; free: ISODate[]; onBooksNights: number; historyStays: number };
/** Nuits d'un séjour qui tombent dans [from, to[. */
const overlapNights = (checkIn: ISODate, checkOut: ISODate, from: ISODate, to: ISODate) => Math.max(0, diffDays(checkOut < to ? checkOut : to, checkIn > from ? checkIn : from));
export function detectChannelGap(ctx: Ctx, stats: WindowStat[]): Signal<ChannelGapPayload>[] {
  const horizonDays = threshold("PB-04", "horizonDays"), gapMax = threshold("PB-04", "shareGap");
  if (ctx.channels.length < 2) return [];
  // si l'ensemble du logement est en retard sur son marché, PB-01 traite la cause : un seul diagnostic à la fois
  // et si le marché est inconnu partout, on ne peut pas affirmer que le logement suit son marché : on se tait (inconnu ≠ zéro)
  const withMarket = stats.slice(1).filter((w) => w.startOffset < horizonDays && w.gap !== null);
  if (withMarket.length === 0 || withMarket.some((w) => (w.gap as number) <= threshold("PB-01", "paceGap"))) return [];
  const to = addDays(ctx.today, horizonDays);
  const confirmed = ctx.resas.filter((r) => r.status === "CONFIRMED");
  // part habituelle : séjours terminés, sur douze mois ; la part d'un canal non identifié rend la comparaison peu fiable
  const hist = confirmed.filter((r) => r.checkOut <= ctx.today && r.checkIn >= addDays(ctx.today, -365));
  if (hist.length < threshold("PB-04", "minHistoryStays")) return [];
  const unknown = hist.filter((r) => !ctx.channels.includes(r.channel as Channel)).length;
  const declaredHist = hist.filter((r) => ctx.channels.includes(r.channel as Channel));
  if (unknown / hist.length > threshold("PB-04", "maxUnknownChannelShare") || declaredHist.length === 0) return [];
  const histNights: Record<string, number> = {}; let histTotal = 0;
  for (const r of declaredHist) { histNights[r.channel] = (histNights[r.channel] ?? 0) + r.nights; histTotal += r.nights; }
  const books: Record<string, number> = {}; let booksTotal = 0, booksUnknown = 0;
  for (const r of confirmed) {
    const n = overlapNights(r.checkIn, r.checkOut, ctx.today, to);
    if (n <= 0) continue;
    if (!ctx.channels.includes(r.channel as Channel)) { booksUnknown += n; continue; }
    books[r.channel] = (books[r.channel] ?? 0) + n; booksTotal += n;
  }
  // la même garde que pour l'historique : trop de nuits à venir sur un canal non identifié faussent les parts
  if (booksTotal + booksUnknown > 0 && booksUnknown / (booksTotal + booksUnknown) > threshold("PB-04", "maxUnknownChannelShare")) return [];
  if (booksTotal < threshold("PB-04", "minOnBooksNights") || histTotal === 0) return [];
  const free = ctx.days.filter((d) => d.state === "FREE" && d.priceCents !== null && d.date >= ctx.today && d.date < to && !ctx.claimed.has(d.date)).map((d) => d.date);
  if (free.length < threshold("PB-04", "minFreeNights")) return [];
  const worst = ctx.channels
    .map((c) => ({ c, hist: (histNights[c] ?? 0) / histTotal, books: (books[c] ?? 0) / booksTotal }))
    .filter((x) => x.hist >= threshold("PB-04", "minHistoricalShare") && x.books - x.hist <= gapMax)
    .sort((a, b) => (a.books - a.hist) - (b.books - b.hist))[0];
  if (!worst) return [];
  const target = free.slice(0, threshold("PB-04", "maxTargetNights"));
  target.forEach((d) => ctx.claimed.add(d));
  return [{
    playbook: "PB-04", trigger: "CHANNEL_UNDERPERFORMS", dedupe: worst.c, channel: worst.c, from: target[0], to: addDays(target[target.length - 1], 1), dates: target,
    measures: [
      m("shareGap", "Part du canal dans les nuits réservées, moins sa part habituelle", round2(worst.books - worst.hist), gapMax, "<=", "points"),
      m("onBooksShare", "Part du canal dans les nuits réservées à venir", round2(worst.books), null, null, "ratio"),
      m("historicalShare", "Part habituelle du canal (12 mois)", round2(worst.hist), null, null, "ratio"),
    ],
    payload: { channel: worst.c, onBooksShare: worst.books, historicalShare: worst.hist, free, onBooksNights: booksTotal, historyStays: hist.length },
  }];
}

/* ------------------------------------------------------------------ PB-08 */
export type CancellationPayload = { channel: string; checkIn: ISODate; checkOut: ISODate; cancelledAt: ISODate; stayNights: number; reopened: ISODate[]; cancelled14: number | null; rate14: number | null };
/**
 * PB-08 : une annulation récente rouvre des nuits à venir qui sont encore libres. Silencieux tant que l'historique des annulations est inconnu
 * (jamais « zéro annulation »). Ne marque aucune nuit : le playbook ne propose pas d'action sur le prix, il demande une relecture.
 */
export function detectCancellation(ctx: Ctx): Signal<CancellationPayload>[] {
  const win = threshold("PB-08", "windowDays"), maxLead = threshold("PB-08", "maxLeadDays"), minNights = threshold("PB-08", "minReopenedNights"), alert = threshold("PB-08", "alertRate");
  if (!cancellationStats(ctx.cancellations, ctx.cancellationTracking, ctx.resas, ctx.today, win)) return [];
  const from0 = addDays(ctx.today, -win + 1), horizon = addDays(ctx.today, maxLead + 1);
  const raw14 = cancellationStats(ctx.cancellations, ctx.cancellationTracking, ctx.resas, ctx.today, threshold("PB-08", "rateWindowDays"));
  // un taux sur trop peu de réservations n'est pas un taux : il reste inconnu
  const s14 = raw14 && raw14.cancelled + raw14.booked >= threshold("PB-08", "minRateSample") ? raw14 : null;
  const out: Signal<CancellationPayload>[] = [];
  const seen = new Set<string>();
  for (const c of [...(ctx.cancellations ?? [])].sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.channel.localeCompare(b.channel))) {
    if (c.cancelledAt < from0 || c.cancelledAt > ctx.today) continue;
    const key = `${c.channel}:${c.checkIn}:${c.checkOut}`;
    if (seen.has(key)) continue;
    const reopened: ISODate[] = [];
    for (let i = 0; i < c.nights; i++) {
      const d = addDays(c.checkIn, i), day = ctx.byDate.get(d);
      if (d >= ctx.today && d < horizon && day?.state === "FREE") reopened.push(d);
    }
    if (reopened.length < minNights) continue;
    seen.add(key);
    out.push({
      playbook: "PB-08", trigger: "DATES_REOPENED", dedupe: key, channel: (ctx.channels as string[]).includes(c.channel) ? (c.channel as Channel) : null,
      from: reopened[0], to: addDays(reopened[reopened.length - 1], 1), dates: reopened,
      measures: [
        m("reopenedNights", "Nuits rouvertes par l'annulation, encore libres", reopened.length, minNights, ">=", "nuits"),
        m("cancellationRate14", "Taux d'annulation sur 14 jours", s14?.rate ?? null, alert, ">=", "ratio"),
      ],
      payload: { channel: c.channel, checkIn: c.checkIn, checkOut: c.checkOut, cancelledAt: c.cancelledAt, stayNights: c.nights, reopened, cancelled14: s14?.cancelled ?? null, rate14: s14?.rate ?? null },
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-10 */
export type DataDriftPayload = { channel: Channel; ageDays: number | null };
export function detectDataDrift(ctx: Ctx): Signal<DataDriftPayload>[] {
  return ctx.stale.map((channel) => {
    const ps = ctx.promos.filter((p) => p.channel === channel);
    const oldest = ps.map((p) => p.verifiedAt).filter((x): x is Date => !!x).sort((a, b) => +a - +b)[0];
    const ageDays = oldest ? Math.floor((+ctx.now - +oldest) / 86400000) : null;
    return {
      playbook: "PB-10" as const, trigger: "DATA_STALE", dedupe: channel, channel, from: ctx.today, to: addDays(ctx.today, 30), dates: [],
      measures: [m("ageDays", "Ancienneté de la dernière vérification", ageDays, threshold("PB-10", "maxAgeDays"), ">", "jours")],
      payload: { channel, ageDays },
    };
  });
}

/** Ordre d'évaluation fixe : un playbook qui marque des nuits les retire aux suivants (veto d'abord, puis causes structurelles, puis rythme). */
export const SIGNAL_ORDER: PlaybookCode[] = ["PB-06", "PB-13", "PB-05", "PB-03", "PB-07", "PB-02", "PB-01", "PB-04", "PB-08", "PB-10"];
