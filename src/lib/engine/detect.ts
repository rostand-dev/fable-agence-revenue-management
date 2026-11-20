import { addDays, diffDays, fmtDay, type ISODate } from "../dates";
import { euro, pct } from "../format";
import { auditCandidate, type AuditContext } from "./audit";
import { DEMAND_MODEL_NOTE, percentileAfter, sellProbability } from "./demand";
import { cumulativeDiscountPct, hardFloorCents, missingEconomics, simulateStack, strategyFloorCents, UnknownEconomics } from "./economics";
import { channelShare, leadTimes, medianLos, windowStats, type WindowStat } from "./metrics";
import type { Candidate, Channel, Day, DetectedOpportunity, Diagnosis, DiagnosisStep, EconomicModel, Evidence, Promo, Resa, StackResult, Strategy } from "./types";
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

type Ctx = EngineInput & {
  byDate: Map<ISODate, Day>; channels: Channel[]; refChannel: Channel; refLos: number;
  lead: ReturnType<typeof leadTimes>; share: Record<string, number>; audit: AuditContext; claimed: Set<ISODate>;
  stale: Channel[];
};

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;

export function promosOn(promos: Promo[], channel: Channel, date: ISODate): Promo[] {
  return promos.filter((p) => p.channel === channel && (!p.stayFrom || p.stayFrom <= date) && (!p.stayTo || date < p.stayTo));
}
function runs(dates: ISODate[]): ISODate[][] {
  const out: ISODate[][] = []; const s = [...dates].sort();
  for (const d of s) { const last = out[out.length - 1]; if (last && addDays(last[last.length - 1], 1) === d) last.push(d); else out.push([d]); }
  return out;
}
const overlaps = (ctx: Ctx, from: ISODate, to: ISODate) => ctx.activeRanges.some((r) => r.from < to && from < r.to);

/** Multiplicateur du prix du calendrier vers le prix affiché sur le canal : 1 + majoration ÷ 100. Majoration inconnue = erreur, jamais 0 %. */
export function markupFactor(markups: EngineInput["markups"], channel: Channel): number {
  if (!markups) return 1;
  const m = markups[channel];
  if (m === undefined || m === null) throw new UnknownEconomics(["majoration " + CHANNEL_LABEL[channel]]);
  return 1 + m / 100;
}
/** `price` = prix du calendrier (avant majoration). Le prix publié sur le canal est price × (1 + majoration), puis remises, commission, coûts. */
function stack(ctx: Ctx, channel: Channel, nights: number, price: number, promos: Promo[] | { label: string; discountPct: number }[]): StackResult {
  return simulateStack({ model: ctx.model, channel, nights, publishedNightlyCents: Math.round(price * markupFactor(ctx.markups, channel)), promos: promos.map((p) => ({ label: p.label, discountPct: p.discountPct })) });
}
const markupPctOf = (ctx: Ctx, channel: Channel): number => (ctx.markups?.[channel] ?? 0);
const fmtPctFr = (x: number) => (Math.round(x * 100) / 100).toString().replace(".", ",") + " %";
/** Espérance de contribution sur un ensemble de nuits libres, pour un prix et des remises donnés. */
function expected(ctx: Ctx, dates: ISODate[], channel: Channel, priceFactor: number, promosFor: (d: ISODate) => { label: string; discountPct: number }[], los: number, demandFactor = 1): number | null {
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
function finalize(ctx: Ctx, draft: Omit<Candidate, "audit">, from: ISODate, to: ISODate): Candidate {
  return { ...draft, audit: auditCandidate(draft, { ...ctx.audit, window: { from, to }, conflict: draft.type !== "NO_ACTION" && draft.type !== "MIN_PRICE_CHANGE" && overlaps(ctx, from, to) }) };
}
/** Écriture PriceLabs par API seulement si la capacité existe pour ce logement (US-002) ; sinon procédure manuelle guidée. */
const plExec = (ctx: Ctx): Candidate["executionMode"] => (ctx.capabilities["pricelabs.write"] ? "API_PRICELABS" : "MANUAL_RUNBOOK");

function noAction(ctx: Ctx, from: ISODate, to: ISODate, current: StackResult | null, why: string, reviewInDays = 7): Candidate {
  return finalize(ctx, {
    type: "NO_ACTION", label: "Ne rien faire et réévaluer", detail: why, agent: "direction",
    target: { system: "INTERNAL" }, parameters: {}, nightsTouched: 0, priceChangePct: null, current, proposed: null,
    expectedDeltaCents: 0, hypothesis: "Référence : la situation actuelle est maintenue telle quelle.",
    rollbackPlan: "", executionMode: "NONE", risk: "LOW", reviewAt: addDays(ctx.today, reviewInDays), measurementWindowDays: reviewInDays,
  }, from, to);
}
/** Retient l'option non rejetée à la meilleure espérance ; sous 15 € d'écart, l'inaction l'emporte. */
function pick(cands: Candidate[], opts: { preferNoAction?: boolean; forceType?: Candidate["type"]; veto?: boolean } = {}): number {
  if (opts.forceType) { const i = cands.findIndex((c) => c.type === opts.forceType && c.audit.verdict !== "REJECT"); if (i >= 0) return i; }
  const na = cands.findIndex((c) => c.type === "NO_ACTION");
  if (opts.preferNoAction && na >= 0 && cands[na].audit.verdict !== "REJECT") return na;
  let best = -1;
  cands.forEach((c, i) => {
    if (c.audit.verdict === "REJECT" || c.type === "NO_ACTION" || c.expectedDeltaCents === null) return;
    if (best < 0 || c.expectedDeltaCents! > cands[best].expectedDeltaCents!) best = i;
  });
  if (best >= 0 && (opts.veto || cands[best].expectedDeltaCents! >= 1500)) return best;
  if (na >= 0 && cands[na].audit.verdict !== "REJECT") return na;
  return best >= 0 ? best : Math.max(0, cands.findIndex((c) => c.audit.verdict !== "REJECT"));
}
function confidence(parts: [boolean, number][], base = 0.5): number {
  return Math.round(Math.min(0.92, Math.max(0.2, parts.reduce((a, [ok, w]) => a + (ok ? w : 0), base))) * 100) / 100;
}
function refPromos(ctx: Ctx, channel: Channel, dates: ISODate[]): Promo[] { return dates.length ? promosOn(ctx.promos, channel, dates[0]) : []; }
function avgDay(ctx: Ctx, dates: ISODate[]) {
  const ds = dates.map((d) => ctx.byDate.get(d)!).filter(Boolean);
  const num = (f: (d: Day) => number | null) => { const xs = ds.map(f).filter((x): x is number => x !== null); return xs.length ? avg(xs) : null; };
  return { price: num((d) => d.priceCents), occ: num((d) => d.marketOccupancy), pctl: num((d) => d.pricePercentile), minStay: num((d) => d.minStay) };
}
const srcCal = (ctx: Ctx) => (ctx.property.isDemo ? "Calendrier de démonstration" : "PriceLabs · disponibilités");
const srcMkt = (ctx: Ctx) => (ctx.property.isDemo ? "Marché de démonstration" : "PriceLabs · marché");
const srcPL = (ctx: Ctx) => (ctx.property.isDemo ? "Grille de démonstration" : ctx.priceSource === "SUPERHOTE" ? "SuperHote · calendrier" : "PriceLabs · prix recommandé");

/* ------------------------------------------------------------------ PB-06 */
function floorBreach(ctx: Ctx): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  const los = Math.max(ctx.strategy.minStay ?? 2, 2);
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
    const a = avgDay(ctx, run); const price = a.price!;
    const promos = refPromos(ctx, channel, run);
    const cur = stack(ctx, channel, los, price, promos);
    const hard = hardFloorCents(ctx.model, channel, los), strat = strategyFloorCents(ctx.model, channel, los);
    const rule = ctx.byDate.get(run[0])!.rule;
    const ruleCut = rule ? Number((rule.match(/(\d+(?:[.,]\d+)?)\s*%/)?.[1] ?? "0").replace(",", ".")) : 0;
    const promoFn = (d: ISODate) => promosOn(ctx.promos, channel, d);
    const base = expected(ctx, run, channel, 1, promoFn, los);
    const cands: Candidate[] = [];
    if (rule && ruleCut > 0) {
      const f = 1 / (1 - ruleCut / 100); const e = expected(ctx, run, channel, f, promoFn, los);
      cands.push(finalize(ctx, {
        type: "RULE_EXCLUSION", label: `Exclure la règle « ${rule} » sur ces dates`,
        detail: `Le prix publié revient à ${euro(price * f)} la nuit, valeur calculée par PriceLabs avant la règle.`, agent: "pricing",
        target: { system: "PRICELABS" }, parameters: { rule, restoresFloor: true, nightlyCents: Math.round(price * f), dates: run }, nightsTouched: run.length,
        priceChangePct: (f - 1) * 100, current: cur, proposed: stack(ctx, channel, los, price * f, promos),
        expectedDeltaCents: base !== null && e !== null ? e - base : null,
        hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Réactiver la règle sur les dates concernées.", executionMode: plExec(ctx), risk: "MEDIUM", measurementWindowDays: 7,
      }, from, to));
    }
    // prix du calendrier (avant majoration, entier en euros) dont le prix vendu atteint un plancher donné : plancher ÷ (1 − cumul remises) ÷ (1 + majoration)
    const mk = markupFactor(ctx.markups, channel);
    const baseFor = (floor: number) => Math.ceil(floor / (1 - cur.cumulativeDiscountPct / 100) / mk / 100) * 100;
    const needHard = baseFor(hard), needStrat = baseFor(strat);
    const priceOpt = (needed: number, floor: number, kind: "absolu" | "stratégique"): Omit<Candidate, "audit"> => {
      const f2 = needed / price;
      return {
        type: "PRICE_OVERRIDE", label: `Poser un prix daté à ${euro(needed)} la nuit (plancher ${kind})`,
        detail: `Plus petit prix du calendrier qui ramène le prix vendu ${CHANNEL_LABEL[channel]} au plancher ${kind} de ${euro(floor)}${ctx.markups ? `, majoration de ${fmtPctFr(markupPctOf(ctx, channel))} comprise` : ""}.`, agent: "pricing",
        target: { system: "PRICELABS" }, parameters: { nightlyCents: needed, restoresFloor: true, floorKind: kind, dates: run }, nightsTouched: run.length, priceChangePct: (f2 - 1) * 100,
        current: cur, proposed: stack(ctx, channel, los, needed, promos), expectedDeltaCents: base !== null ? (() => { const e2 = expected(ctx, run, channel, f2, promoFn, los); return e2 !== null ? e2 - base : null; })() : null,
        hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Supprimer le prix daté : PriceLabs reprend son calcul.", executionMode: plExec(ctx), risk: "MEDIUM", measurementWindowDays: 7,
      };
    };
    if (Number.isFinite(needHard)) cands.push(finalize(ctx, priceOpt(needHard, hard, "absolu"), from, to));
    if (Number.isFinite(needStrat) && needStrat > needHard) cands.push(finalize(ctx, priceOpt(needStrat, strat, "stratégique"), from, to));
    cands.push(noAction(ctx, from, to, cur, "Laisser la grille en l'état jusqu'à la prochaine revue.", 1));
    const evidence: Evidence[] = [
      { kind: "fait", label: "Prix du calendrier (avant majoration)", value: euro(price), source: srcPL(ctx) },
      ...(ctx.markups ? [
        { kind: "fait" as const, label: `Majoration ${CHANNEL_LABEL[channel]}`, value: `+${fmtPctFr(markupPctOf(ctx, channel))}`, source: "Réglages du logement" },
        { kind: "fait" as const, label: `Prix publié ${CHANNEL_LABEL[channel]}`, value: `${euro(cur.publishedNightlyCents)} (${euro(price)} × ${mk.toFixed(2).replace(".", ",")})`, source: "Calcul" },
      ] : []),
      { kind: "fait", label: `Prix vendu ${CHANNEL_LABEL[channel]} après remises`, value: `${euro(cur.soldNightlyCents)} (cumul ${cur.cumulativeDiscountPct.toFixed(1).replace(".", ",")} %)`, source: "Simulateur de cumul" },
      { kind: "comparaison", label: `Plancher absolu · ${los} nuits`, value: euro(hard), source: "Modèle économique" },
      { kind: "comparaison", label: "Calcul du prix proposé", value: `plancher ${euro(hard)} ÷ (1 − ${cur.cumulativeDiscountPct.toFixed(1).replace(".", ",")} % de remises) ÷ ${mk.toFixed(2).replace(".", ",")} de majoration, arrondi à l'euro supérieur = ${euro(needHard)}${needStrat > needHard ? ` ; au plancher stratégique de ${euro(strat)} : ${euro(needStrat)}` : ""}`, source: "Calcul" },
      { kind: "comparaison", label: "Contribution par nuit simulée", value: `${euro(cur.contributionPerNightCents)} pour un minimum de ${euro(ctx.model.hardContributionPerNightCents)}`, source: "Simulateur de cumul" },
      ...(rule ? [{ kind: "fait" as const, label: "Règle à l'origine du prix", value: rule, source: srcPL(ctx) }] : []),
    ];
    const diagnosis: Diagnosis = {
      primary: "FLOOR_BREACH", primaryLabel: "Le prix vendu passe sous le plancher économique absolu",
      alternatives: [{ cause: "DISCOUNT_STACK", label: "Cumul de remises du canal", why: promos.length ? `${plural(promos.length, "remise")} active${promos.length > 1 ? "s" : ""} sur le canal s'ajoute${promos.length > 1 ? "nt" : ""} à la règle.` : "Aucune remise du canal relevée sur ces dates." }],
      confidence: confidence([[true, 0.35], [!ctx.stale.includes(channel), 0.1]]),
      confidenceNote: "Constat de calcul : il ne dépend d'aucune hypothèse de demande.",
      tree: [{ question: "Le prix vendu net respecte-t-il le plancher absolu ?", answer: `Non : ${euro(cur.soldNightlyCents)} pour ${euro(hard)}.`, verdict: "non" }],
      evidence,
    };
    out.push({
      playbook: "PB-06", reasonCode: "FLOOR_BREACH",
      title: `Le prix vendu ${CHANNEL_LABEL[channel]} passe sous le plancher absolu sur ${plural(run.length, "nuit")}`,
      stayFrom: from, stayTo: to,
      signalText: `Prix vendu ${euro(cur.soldNightlyCents)} la nuit pour un plancher de ${euro(hard)}`, signalSource: `${srcPL(ctx)} + simulateur de cumul`,
      hypothesisText: rule ? `La règle « ${rule} » s'applique sans tenir compte des remises du canal.` : cur.cumulativeDiscountPct > 0 ? "Le prix publié ne couvre plus les coûts une fois les remises du canal déduites." : `Le prix publié sur ${CHANNEL_LABEL[channel]}${ctx.markups ? `, majoration de ${fmtPctFr(markupPctOf(ctx, channel))} comprise,` : ""} reste sous le plancher ; aucune remise du canal n'intervient.`,
      signals: { soldNightlyCents: cur.soldNightlyCents, hardFloorCents: hard, strategyFloorCents: strat, channel, rule },
      diagnosis, candidates: cands, selected: pick(cands, { veto: true }), veto: true,
      vetoText: `Une vente aujourd'hui sur ${CHANNEL_LABEL[channel]} laisserait ${euro(cur.contributionPerNightCents)} de contribution par nuit, sous le minimum absolu de ${euro(ctx.model.hardContributionPerNightCents)}.`,
      urgency: 2, expiresAt: to,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-11 */
/**
 * Le prix minimum PriceLabs est un plancher mécanique : tant que minimum × (1 + majoration) passe sous le plancher absolu d'un canal,
 * PriceLabs peut vendre sous ce plancher dès que la demande baisse. L'agent d'onboarding propose de relever ce minimum.
 * Il ne se déclenche jamais pour un canal dont la majoration est inconnue (ce canal est exclu de la revue).
 */
function minPriceBelowFloor(ctx: Ctx): DetectedOpportunity[] {
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
  const w = bad[0], newMin = w.need, from = ctx.today, to = addDays(ctx.today, 90);
  const mk = markupFactor(ctx.markups, w.ch), name = CHANNEL_LABEL[w.ch];
  const proposed = stack(ctx, w.ch, los, newMin, []);
  const cands: Candidate[] = [
    finalize(ctx, {
      type: "MIN_PRICE_CHANGE", label: `Relever le prix minimum PriceLabs à ${euro(newMin)}`,
      detail: `Plus petit minimum entier dont le prix vendu ${name} atteint le plancher absolu de ${euro(w.hard)}${ctx.markups ? `, majoration de ${fmtPctFr(markupPctOf(ctx, w.ch))} comprise` : ""}. Aucun prix daté n'est posé : seule la limite basse change.`, agent: "onboarding",
      target: { system: "PRICELABS" }, parameters: { minPriceCents: newMin, previousMinPriceCents: min, restoresFloor: true, channel: w.ch }, nightsTouched: 0, priceChangePct: (newMin / min - 1) * 100,
      current: w.cur, proposed, expectedDeltaCents: null,
      hypothesis: "Constat de calcul : il ne dépend d'aucune hypothèse de demande. Relever le minimum peut réduire les ventes les jours où PriceLabs descendrait à cette limite.",
      rollbackPlan: `Remettre le prix minimum à ${euro(min)} dans PriceLabs.`, executionMode: plExec(ctx), risk: "MEDIUM", measurementWindowDays: 14,
    }, from, to),
    noAction(ctx, from, to, w.cur, "Laisser le minimum actuel : PriceLabs pourra vendre sous le plancher absolu.", 7),
  ];
  const evidence: Evidence[] = [
    { kind: "fait", label: "Prix minimum PriceLabs", value: euro(min), source: "PriceLabs · réglages de l'annonce" },
    ...(ctx.markups ? [{ kind: "fait" as const, label: `Majoration ${name}`, value: `+${fmtPctFr(markupPctOf(ctx, w.ch))}`, source: "Réglages du logement" }] : []),
    { kind: "fait", label: `Prix vendu ${name} au minimum`, value: `${euro(w.cur.soldNightlyCents)} (${euro(min)} × ${mk.toFixed(2).replace(".", ",")})`, source: "Simulateur de cumul" },
    { kind: "comparaison", label: `Plancher absolu · ${los} nuits`, value: euro(w.hard), source: "Modèle économique" },
    { kind: "comparaison", label: "Calcul du minimum proposé", value: `plancher ${euro(w.hard)} ÷ ${mk.toFixed(2).replace(".", ",")} de majoration, arrondi à l'euro supérieur = ${euro(newMin)}`, source: "Calcul" },
  ];
  return [{
    playbook: "PB-11", dedupe: "min", reasonCode: "MIN_PRICE_BELOW_FLOOR",
    title: `Le prix minimum PriceLabs laisse vendre ${name} sous le plancher absolu`,
    stayFrom: from, stayTo: to,
    signalText: `Minimum PriceLabs ${euro(min)} : prix vendu ${euro(w.cur.soldNightlyCents)} au minimum, pour un plancher de ${euro(w.hard)}`, signalSource: "PriceLabs · réglages + simulateur de cumul",
    hypothesisText: "Le minimum configuré dans PriceLabs est plus bas que ce que le modèle économique du logement autorise.",
    signals: { minPriceCents: min, soldAtMinCents: w.cur.soldNightlyCents, hardFloorCents: w.hard, proposedMinCents: newMin, channel: w.ch },
    diagnosis: {
      primary: "FLOOR_BREACH", primaryLabel: "Le prix minimum PriceLabs est sous le plancher économique absolu",
      alternatives: [{ cause: "BASE_PRICE_LOW", label: "Prix de base trop bas", why: "Écartée : seul le minimum permet de descendre sous le plancher ; le prix de base n'est pas en cause." }],
      confidence: confidence([[true, 0.35], [ctx.priceSource === "SUPERHOTE", 0.1]]),
      confidenceNote: "Constat de calcul : il ne dépend d'aucune hypothèse de demande.",
      tree: [{ question: "Le prix vendu au minimum respecte-t-il le plancher absolu ?", answer: `Non : ${euro(w.cur.soldNightlyCents)} pour ${euro(w.hard)}.`, verdict: "non" }],
      evidence,
    },
    candidates: cands, selected: pick(cands, { forceType: "MIN_PRICE_CHANGE" }), veto: false, urgency: 1, expiresAt: addDays(ctx.today, 7),
  }];
}

/* ------------------------------------------------------------------ PB-05 */
function stackRisk(ctx: Ctx): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  const los = Math.max(ctx.refLos, 2);
  for (const channel of ctx.channels) {
    const dates = ctx.days.filter((d) => {
      if (d.state !== "FREE" || d.priceCents === null || ctx.claimed.has(d.date)) return false;
      const ps = promosOn(ctx.promos, channel, d.date);
      if (ps.length < 2) return false;
      const s = stack(ctx, channel, los, d.priceCents, ps);
      return s.cumulativeDiscountPct > ctx.strategy.maxDiscountStackPct || s.soldNightlyCents < strategyFloorCents(ctx.model, channel, los);
    }).map((d) => d.date);
    for (const run of runs(dates).filter((r) => r.length >= 2)) {
      const from = run[0], to = addDays(run[run.length - 1], 1);
      run.forEach((d) => ctx.claimed.add(d));
      const price = avgDay(ctx, run).price!;
      const promos = refPromos(ctx, channel, run);
      const cur = stack(ctx, channel, los, price, promos);
      const strat = strategyFloorCents(ctx.model, channel, los);
      const base = expected(ctx, run, channel, 1, (d) => promosOn(ctx.promos, channel, d), los);
      // remise à retirer : la plus petite dont le retrait rétablit le plancher stratégique, sinon la plus forte
      const sorted = [...promos].sort((a, b) => (a.stayFrom ? 0 : 1) - (b.stayFrom ? 0 : 1) || a.discountPct - b.discountPct);
      const fix = sorted.find((p) => stack(ctx, channel, los, price, promos.filter((x) => x.id !== p.id)).soldNightlyCents >= strat) ?? sorted[sorted.length - 1];
      const rest = promos.filter((p) => p.id !== fix.id);
      const e = expected(ctx, run, channel, 1, (d) => promosOn(ctx.promos, channel, d).filter((p) => p.id !== fix.id), los);
      const cands: Candidate[] = [
        finalize(ctx, {
          type: "PROMO_REMOVAL", label: `Retirer « ${fix.label} » sur ces dates`,
          detail: `Le cumul redescend à ${cumulativeDiscountPct(rest.map((p) => p.discountPct)).toFixed(1).replace(".", ",")} % ; les autres remises restent actives.`, agent: "distribution",
          target: { system: channel, channel }, parameters: { promotionId: fix.id, promotionLabel: fix.label, channel }, nightsTouched: run.length, priceChangePct: null,
          current: cur, proposed: stack(ctx, channel, los, price, rest), expectedDeltaCents: base !== null && e !== null ? Math.round((e - base) * (ctx.share[channel] ?? 0.5)) : null,
          hypothesis: `${DEMAND_MODEL_NOTE} Écart pondéré par la part du canal (${pct(ctx.share[channel] ?? 0.5)}).`,
          rollbackPlan: "Réactiver la promotion avec les mêmes dates et le même taux.", executionMode: "MANUAL_RUNBOOK", risk: "MEDIUM", measurementWindowDays: 14,
        }, from, to),
        noAction(ctx, from, to, cur, "Conserver les remises actives jusqu'à la prochaine revue hebdomadaire."),
      ];
      out.push({
        playbook: "PB-05", reasonCode: "DISCOUNT_STACK_RISK",
        title: `${plural(promos.length, "remise")} ${CHANNEL_LABEL[channel]} se cumulent à ${cur.cumulativeDiscountPct.toFixed(0)} % sur ${plural(run.length, "nuit")}`,
        stayFrom: from, stayTo: to,
        signalText: `Cumul ${cur.cumulativeDiscountPct.toFixed(1).replace(".", ",")} % : prix vendu ${euro(cur.soldNightlyCents)} pour un plancher stratégique de ${euro(strat)}`,
        signalSource: `Registre des promotions ${CHANNEL_LABEL[channel]}`,
        hypothesisText: "Les remises ont été posées séparément ; leur effet cumulé n'apparaît dans aucun extranet.",
        signals: { cumulativeDiscountPct: cur.cumulativeDiscountPct, soldNightlyCents: cur.soldNightlyCents, strategyFloorCents: strat, channel, promotions: promos.map((p) => p.label) },
        diagnosis: {
          primary: "DISCOUNT_STACK", primaryLabel: "Empilement de remises sur un même canal",
          alternatives: [{ cause: "PRICE_HIGH", label: "Prix publié trop bas pour ces remises", why: "Relever le prix publié compenserait le cumul, mais pénaliserait aussi l'autre canal." }],
          confidence: confidence([[true, 0.3], [!ctx.stale.includes(channel), 0.12]]),
          confidenceNote: ctx.stale.includes(channel) ? "Registre des promotions non vérifié depuis plus de 7 jours." : "Registre des promotions vérifié depuis moins de 7 jours.",
          tree: [
            { question: "Une promotion est-elle déjà active ou cumulée ?", answer: `Oui : ${promos.map((p) => `${p.label} ${p.discountPct} %`).join(", ")}.`, verdict: "oui" },
            { question: "Le prix vendu reste-t-il au-dessus du plancher absolu ?", answer: `Oui : ${euro(cur.soldNightlyCents)} pour ${euro(hardFloorCents(ctx.model, channel, los))}.`, verdict: "oui" },
          ],
          evidence: [
            ...promos.map((p) => ({ kind: "fait" as const, label: p.label, value: `−${p.discountPct} %${p.stayFrom ? ` · séjours du ${fmtDay(p.stayFrom)} au ${fmtDay(p.stayTo!)}` : " · permanente"}`, source: `Registre ${CHANNEL_LABEL[channel]}` })),
            { kind: "comparaison", label: "Plancher stratégique", value: euro(strat), source: "Modèle économique" },
            { kind: "comparaison", label: "Prix vendu simulé", value: euro(cur.soldNightlyCents), source: "Simulateur de cumul" },
          ],
        },
        candidates: cands, selected: pick(cands, { veto: true }), veto: false, urgency: 1 + Math.max(0, 30 - diffDays(from, ctx.today)) / 30, expiresAt: to,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ PB-03 */
function orphanGaps(ctx: Ctx): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  const free = ctx.days.filter((d) => d.state === "FREE" && !ctx.claimed.has(d.date) && diffDays(d.date, ctx.today) >= 2 && diffDays(d.date, ctx.today) <= 45).map((d) => d.date);
  for (const run of runs(free)) {
    if (run.length > 3) continue;
    const before = ctx.byDate.get(addDays(run[0], -1)), after = ctx.byDate.get(addDays(run[run.length - 1], 1));
    if (!before || !after || before.state === "FREE" || after.state === "FREE") continue;
    const a = avgDay(ctx, run);
    const minStay = Math.round(a.minStay ?? ctx.strategy.minStay ?? 0);
    if (!minStay || minStay <= run.length || a.price === null) continue;
    const from = run[0], to = addDays(run[run.length - 1], 1), L = run.length, channel = ctx.refChannel;
    run.forEach((d) => ctx.claimed.add(d));
    const promos = refPromos(ctx, channel, run);
    const proposed = stack(ctx, channel, L, a.price, promos);
    const p = a.occ !== null && a.pctl !== null ? sellProbability(a.occ, a.pctl) : null;
    const cands: Candidate[] = [
      finalize(ctx, {
        type: "MIN_STAY_OVERRIDE", label: `Ramener le séjour minimum à ${plural(L, "nuit")} sur ces dates`,
        detail: `Les ${plural(L, "nuit")} deviennent réservables au prix publié de ${euro(a.price)} ; aucun prix n'est modifié.`, agent: "pricing",
        target: { system: "PRICELABS" }, parameters: { minStay: L, previousMinStay: minStay, dates: run }, nightsTouched: L, priceChangePct: null,
        current: null, proposed, expectedDeltaCents: p === null ? null : Math.round(p * proposed.contributionCents),
        hypothesis: p === null ? "Probabilité de vente inconnue : données de marché absentes." : `Contribution d'un séjour de ${plural(L, "nuit")} (${euro(proposed.contributionCents)}) × probabilité de vente approchée (${pct(p)}). ${DEMAND_MODEL_NOTE}`,
        rollbackPlan: `Rétablir le séjour minimum à ${minStay} nuits sur ces dates.`, executionMode: plExec(ctx), risk: "LOW", measurementWindowDays: 7,
      }, from, to),
      noAction(ctx, from, to, null, "Laisser le trou invendable : les nuits restent bloquées par le séjour minimum."),
    ];
    out.push({
      playbook: "PB-03", reasonCode: "ORPHAN_GAP",
      title: `${plural(L, "nuit")} invendable${L > 1 ? "s" : ""} entre deux réservations`,
      stayFrom: from, stayTo: to,
      signalText: `Trou de ${plural(L, "nuit")} encadré par deux séjours, avec un séjour minimum de ${minStay} nuits`, signalSource: srcCal(ctx),
      hypothesisText: "Le prix n'est pas en cause : la restriction empêche toute réservation sur ces nuits.",
      signals: { gapNights: L, minimumStay: minStay, pricePercentile: a.pctl, marketOccupancy: a.occ },
      diagnosis: {
        primary: "RESTRICTION_MISMATCH", primaryLabel: "Séjour minimum incompatible avec la durée du trou",
        alternatives: [{ cause: "PRICE_HIGH", label: "Prix trop élevé", why: a.pctl !== null ? `Écartée : le prix se situe au ${Math.round(a.pctl)}e percentile du marché, et aucune réservation n'est possible quel que soit le prix.` : "Non vérifiable : position de prix inconnue." }],
        confidence: confidence([[true, 0.3], [a.pctl !== null, 0.06], [a.occ !== null, 0.06]]),
        confidenceNote: "La restriction est un fait de calendrier, pas une interprétation.",
        tree: [
          { question: "Le logement est-il vendable sur ces dates ?", answer: `Non : ${plural(L, "nuit")} libre${L > 1 ? "s" : ""} pour un séjour minimum de ${minStay}.`, verdict: "non" },
          { question: "Le coût de séjour est-il couvert sur une durée aussi courte ?", answer: `Contribution simulée ${euro(proposed.contributionCents)} pour ${plural(L, "nuit")}.`, verdict: proposed.contributionCents > 0 ? "oui" : "non" },
        ],
        evidence: [
          { kind: "fait", label: "Nuits libres", value: `${fmtDay(from)} → ${fmtDay(to)}`, source: srcCal(ctx) },
          { kind: "fait", label: "Séjour minimum en vigueur", value: `${minStay} nuits`, source: srcPL(ctx) },
          { kind: "comparaison", label: "Occupation du marché sur ces dates", value: pct(a.occ), source: srcMkt(ctx) },
          { kind: "comparaison", label: "Position de prix", value: a.pctl === null ? "inconnue" : `${Math.round(a.pctl)}e percentile`, source: srcMkt(ctx) },
        ],
      },
      candidates: cands, selected: pick(cands), veto: false, urgency: 1 + Math.max(0, 30 - diffDays(from, ctx.today)) / 30, expiresAt: from,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-07 */
function eventUplift(ctx: Ctx): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  const dates = ctx.days.filter((d) => d.state === "FREE" && d.event && !ctx.claimed.has(d.date) && (d.marketOccupancy ?? 0) >= 0.8 && d.pricePercentile !== null && d.pricePercentile <= 45 && d.priceCents !== null).map((d) => d.date);
  for (const run of runs(dates)) {
    const from = run[0], to = addDays(run[run.length - 1], 1), channel = ctx.refChannel, los = Math.max(Math.min(ctx.refLos, run.length), ctx.strategy.minStay ?? 1, 1);
    run.forEach((d) => ctx.claimed.add(d));
    const a = avgDay(ctx, run), ev = ctx.byDate.get(run[0])!.event!;
    const promoFn = (d: ISODate) => promosOn(ctx.promos, channel, d);
    const promos = refPromos(ctx, channel, run), cur = stack(ctx, channel, los, a.price!, promos);
    const base = expected(ctx, run, channel, 1, promoFn, los);
    const mk = (up: number): Candidate => {
      const e = expected(ctx, run, channel, 1 + up / 100, promoFn, los);
      const capped = ctx.strategy.maxPriceCents ? Math.min(a.price! * (1 + up / 100), ctx.strategy.maxPriceCents) : a.price! * (1 + up / 100);
      return finalize(ctx, {
        type: "PRICE_OVERRIDE", label: `Relever le prix de ${up} % sur les dates de l'événement`,
        detail: `Prix publié moyen porté de ${euro(a.price)} à ${euro(capped)} la nuit.`, agent: "pricing",
        target: { system: "PRICELABS" }, parameters: { changePct: up, nightlyCents: Math.round(capped), dates: run }, nightsTouched: run.length, priceChangePct: up,
        current: cur, proposed: stack(ctx, channel, los, capped, promos), expectedDeltaCents: base !== null && e !== null ? e - base : null,
        hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Supprimer le prix daté : PriceLabs reprend son calcul.", executionMode: plExec(ctx), risk: "MEDIUM", measurementWindowDays: 14,
      }, from, to);
    };
    const cands = [mk(12), mk(5), noAction(ctx, from, to, cur, "Laisser PriceLabs ajuster seul à l'approche de la date.")];
    out.push({
      playbook: "PB-07", reasonCode: "EVENT_UPLIFT",
      title: `Demande d'événement non reflétée dans le prix sur ${plural(run.length, "nuit")}`,
      stayFrom: from, stayTo: to,
      signalText: `Marché occupé à ${pct(a.occ)} pour « ${ev} », prix au ${Math.round(a.pctl!)}e percentile`, signalSource: srcMkt(ctx),
      hypothesisText: "L'événement n'est pas encore pris en compte par la grille : le logement se vendrait en dessous de son marché.",
      signals: { event: ev, marketOccupancy: a.occ, pricePercentile: a.pctl },
      diagnosis: {
        primary: "EVENT_NOT_PRICED", primaryLabel: "Événement local non reflété dans le prix",
        alternatives: [{ cause: "DEMAND_WEAK", label: "Signal d'événement non confirmé", why: "L'occupation du marché confirme la tension ; l'événement lui-même reste une donnée déclarée." }],
        confidence: confidence([[true, 0.15], [(a.occ ?? 0) >= 0.85, 0.1], [a.pctl! <= 35, 0.08]]),
        confidenceNote: "Le signal repose sur deux mesures de marché concordantes.",
        tree: [
          { question: "La demande du marché est-elle forte sur ces dates ?", answer: `Oui : ${pct(a.occ)} d'occupation.`, verdict: "oui" },
          { question: "Le prix est-il aligné sur le marché ?", answer: `Non : ${Math.round(a.pctl!)}e percentile.`, verdict: "non" },
        ],
        evidence: [
          { kind: "fait", label: "Événement", value: ev, source: srcMkt(ctx) },
          { kind: "comparaison", label: "Occupation du marché", value: pct(a.occ), source: srcMkt(ctx) },
          { kind: "comparaison", label: "Position de prix", value: `${Math.round(a.pctl!)}e percentile`, source: srcMkt(ctx) },
          { kind: "fait", label: "Prix publié moyen", value: euro(a.price), source: srcPL(ctx) },
        ],
      },
      candidates: cands, selected: pick(cands), veto: false, urgency: 1 + Math.max(0, 30 - diffDays(from, ctx.today)) / 60, expiresAt: from,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-01 */
function paceLow(ctx: Ctx, stats: WindowStat[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const w of stats.slice(1)) {
    if (w.gap === null || w.gap > -0.18) continue;
    const free = w.freeDates.filter((d) => !ctx.claimed.has(d));
    if (free.length < 4) continue;
    const a = avgDay(ctx, free);
    if (a.price === null || a.occ === null) continue;
    const from = w.from, to = w.to, channel = ctx.refChannel, los = Math.max(ctx.refLos, ctx.strategy.minStay ?? 1, 1);
    const notOpen = ctx.lead !== null && w.startOffset > ctx.lead.p75;
    const weak = a.occ < 0.35;
    const priceHigh = a.pctl !== null && a.pctl >= 65;
    const restr = a.minStay !== null && a.minStay >= 3 && a.minStay > ctx.refLos;
    const promosAll = ctx.channels.flatMap((c) => promosOn(ctx.promos, c, free[0]));
    const tree: DiagnosisStep[] = [
      { question: "La demande du marché est-elle elle-même faible ?", answer: `${pct(a.occ)} d'occupation marché sur la fenêtre.`, verdict: weak ? "oui" : "non" },
      { question: "La fenêtre de réservation est-elle ouverte ?", answer: ctx.lead ? `75 % des réservations arrivent à moins de ${ctx.lead.p75} jours ; la fenêtre commence à J+${w.startOffset}.` : "Historique insuffisant pour le dire.", verdict: ctx.lead ? (notOpen ? "non" : "oui") : "inconnu" },
      { question: "Le prix est-il au-dessus du marché comparable ?", answer: a.pctl === null ? "Position de prix inconnue." : `${Math.round(a.pctl)}e percentile du marché.`, verdict: a.pctl === null ? "inconnu" : priceHigh ? "oui" : "non" },
      { question: "Le séjour minimum bloque-t-il la demande disponible ?", answer: a.minStay === null ? "Séjour minimum inconnu." : `Séjour minimum moyen ${a.minStay.toFixed(1).replace(".", ",")} nuits ; durée médiane des séjours ${ctx.refLos} nuits.`, verdict: a.minStay === null ? "inconnu" : restr ? "oui" : "non" },
      { question: "Une promotion est-elle déjà active ?", answer: promosAll.length ? promosAll.map((p) => `${p.label} (${CHANNEL_LABEL[p.channel]})`).join(", ") + "." : "Aucune promotion active relevée.", verdict: promosAll.length ? "oui" : "non" },
      { question: "Une action récente est-elle en observation ?", answer: overlaps(ctx, from, to) ? "Oui, sur ces dates." : "Non.", verdict: overlaps(ctx, from, to) ? "oui" : "non" },
    ];
    const primary = weak ? "DEMAND_WEAK" : notOpen ? "BOOKING_WINDOW_NOT_OPEN" : priceHigh ? "PRICE_HIGH" : restr ? "RESTRICTION_MISMATCH" : "VISIBILITY_CONVERSION";
    const labels: Record<string, string> = {
      DEMAND_WEAK: "La demande du marché est faible sur la période", BOOKING_WINDOW_NOT_OPEN: "La fenêtre de réservation n'est pas encore ouverte",
      PRICE_HIGH: "Le prix est positionné au-dessus du marché comparable", RESTRICTION_MISMATCH: "Le séjour minimum écarte une partie de la demande",
      VISIBILITY_CONVERSION: "Ni le prix ni les restrictions n'expliquent l'écart : visibilité ou conversion de l'annonce",
    };
    const target = free.slice(0, 14);
    const promoFn = (d: ISODate) => promosOn(ctx.promos, channel, d);
    const promos = refPromos(ctx, channel, target);
    const cur = stack(ctx, channel, los, a.price, promos);
    const base = expected(ctx, target, channel, 1, promoFn, los);
    const eDown = expected(ctx, target, channel, 0.95, promoFn, los);
    const tFrom = target[0], tTo = addDays(target[target.length - 1], 1);
    const cands: Candidate[] = [];
    cands.push(finalize(ctx, {
      type: "PRICE_OVERRIDE", label: `Baisser le prix de 5 % sur ${plural(target.length, "nuit")} libre${target.length > 1 ? "s" : ""}`,
      detail: `Prix publié moyen ramené de ${euro(a.price)} à ${euro(a.price * 0.95)} du ${fmtDay(tFrom)} au ${fmtDay(tTo)}, sur tous les canaux.`, agent: "pricing",
      target: { system: "PRICELABS" }, parameters: { changePct: -5, nightlyCents: Math.round(a.price * 0.95), dates: target }, nightsTouched: target.length, priceChangePct: -5,
      current: cur, proposed: stack(ctx, channel, los, a.price * 0.95, promos), expectedDeltaCents: base !== null && eDown !== null ? eDown - base : null,
      hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Supprimer les prix datés : PriceLabs reprend son calcul.", executionMode: plExec(ctx), risk: "MEDIUM", measurementWindowDays: 7,
    }, tFrom, tTo));
    if (ctx.channels.includes("BOOKING")) {
      const bp = refPromos(ctx, "BOOKING", target);
      const add = { label: "Offre mobile ciblée", discountPct: 10 };
      const bCur = stack(ctx, "BOOKING", los, a.price, bp), bNew = stack(ctx, "BOOKING", los, a.price, [...bp, add]);
      const b0 = expected(ctx, target, "BOOKING", 1, (d) => promosOn(ctx.promos, "BOOKING", d), los);
      const b1 = expected(ctx, target, "BOOKING", 1, (d) => [...promosOn(ctx.promos, "BOOKING", d), add], los);
      cands.push(finalize(ctx, {
        type: "CHANNEL_PROMO", label: "Offre mobile Booking.com à 10 % sur la fenêtre",
        detail: `Remise réservée aux voyageurs sur mobile, séjours du ${fmtDay(tFrom)} au ${fmtDay(tTo)} ; le prix Airbnb reste inchangé.`, agent: "distribution",
        target: { system: "BOOKING", channel: "BOOKING" }, parameters: { kind: "MOBILE", discountPct: 10, label: "Offre mobile ciblée", stayFrom: tFrom, stayTo: tTo }, nightsTouched: target.length, priceChangePct: null,
        current: bCur, proposed: bNew, expectedDeltaCents: b0 !== null && b1 !== null ? Math.round((b1 - b0) * (ctx.share["BOOKING"] ?? 0.5)) : null,
        hypothesis: `${DEMAND_MODEL_NOTE} Écart pondéré par la part de Booking.com (${pct(ctx.share["BOOKING"] ?? 0.5)}) ; le gain de visibilité propre à la promotion n'est pas chiffré.`,
        rollbackPlan: "Désactiver la promotion dans l'extranet Booking.com.", executionMode: "MANUAL_RUNBOOK", risk: "MEDIUM", measurementWindowDays: 7,
      }, tFrom, tTo));
    }
    if (primary === "VISIBILITY_CONVERSION") cands.push(finalize(ctx, {
      type: "LISTING_AUDIT", label: "Auditer l'annonce avant toute remise",
      detail: "Contrôle du titre, des photos, des équipements déclarés, des avis récents et de la conversion par canal.", agent: "annonce",
      target: { system: "INTERNAL" }, parameters: {}, nightsTouched: 0, priceChangePct: null, current: cur, proposed: null, expectedDeltaCents: null,
      hypothesis: "Effet non chiffrable : aucun taux de conversion n'est disponible sans accès partenaire.", rollbackPlan: "Aucune écriture externe : rien à annuler.",
      executionMode: "INTERNAL", risk: "LOW", measurementWindowDays: 14,
    }, tFrom, tTo));
    const why = weak ? "Le marché lui-même se remplit peu : une baisse diluerait le prix sans créer de demande."
      : notOpen ? `Les réservations de ce logement arrivent surtout à moins de ${ctx.lead!.p75} jours : l'écart est attendu à cet horizon.`
      : "Attendre une revue supplémentaire avant d'agir.";
    cands.push(noAction(ctx, from, to, cur, why, notOpen ? Math.max(7, w.startOffset - ctx.lead!.p75) : 7));
    const preferNo = weak || notOpen;
    const selected = pick(cands, { preferNoAction: preferNo, forceType: primary === "VISIBILITY_CONVERSION" ? "LISTING_AUDIT" : undefined });
    out.push({
      playbook: "PB-01", dedupe: w.key, reasonCode: preferNo ? "PACE_BELOW_MARKET_EXPECTED" : "PACE_BELOW_MARKET",
      title: preferNo ? `Remplissage en retrait sur ${w.label}, sans cause tarifaire` : `Remplissage ${Math.round(-w.gap * 100)} points sous le marché sur ${w.label}`,
      stayFrom: from, stayTo: to,
      signalText: `Occupation ${pct(w.occupancy)} pour un marché à ${pct(w.marketOccupancy)} · ${plural(free.length, "nuit")} libre${free.length > 1 ? "s" : ""}`, signalSource: `${srcCal(ctx)} + ${srcMkt(ctx)}`,
      hypothesisText: labels[primary] + ".",
      signals: { propertyOccupancy: w.occupancy, marketOccupancy: w.marketOccupancy, paceGapPoints: Math.round(w.gap * 100), pricePercentile: a.pctl, minimumStay: a.minStay, freeNights: free.length, leadTimeP75: ctx.lead?.p75 ?? null },
      diagnosis: {
        primary, primaryLabel: labels[primary],
        alternatives: (["PRICE_HIGH", "RESTRICTION_MISMATCH", "VISIBILITY_CONVERSION", "DEMAND_WEAK"] as const).filter((c) => c !== primary).slice(0, 3).map((c) => ({
          cause: c, label: labels[c],
          why: c === "PRICE_HIGH" ? (a.pctl === null ? "Non vérifiable : position de prix inconnue." : priceHigh ? `Plausible : ${Math.round(a.pctl)}e percentile.` : `Écartée : ${Math.round(a.pctl)}e percentile.`)
            : c === "RESTRICTION_MISMATCH" ? (restr ? "Plausible : séjour minimum au-dessus de la durée médiane." : "Écartée : séjour minimum compatible avec les séjours habituels.")
            : c === "DEMAND_WEAK" ? (weak ? "Plausible." : `Écartée : le marché est occupé à ${pct(a.occ)}.`)
            : "Non vérifiable sans statistiques d'annonce : reste ouverte.",
        })),
        confidence: confidence([[a.pctl !== null, 0.08], [w.gap <= -0.3, 0.08], [ctx.lead !== null, 0.06], [primary !== "VISIBILITY_CONVERSION", 0.08], [ctx.stale.length === 0, 0.04]]),
        confidenceNote: primary === "VISIBILITY_CONVERSION" ? "Diagnostic par élimination : aucune mesure directe de visibilité." : "Diagnostic fondé sur l'écart au marché et la position de prix relevés.",
        tree,
        evidence: [
          { kind: "fait", label: "Occupation du logement", value: `${pct(w.occupancy)} · ${w.booked} nuits sur ${w.available}`, source: srcCal(ctx) },
          { kind: "comparaison", label: "Occupation du marché", value: pct(w.marketOccupancy), source: srcMkt(ctx) },
          { kind: "comparaison", label: "Position de prix des nuits libres", value: a.pctl === null ? "inconnue" : `${Math.round(a.pctl)}e percentile`, source: srcMkt(ctx) },
          { kind: "fait", label: "Prix publié moyen des nuits libres", value: euro(a.price), source: srcPL(ctx) },
          { kind: "fait", label: "Délai de réservation habituel", value: ctx.lead ? `médiane ${ctx.lead.median} j · 75 % à moins de ${ctx.lead.p75} j (${ctx.lead.sample} séjours)` : "inconnu", source: "Historique des réservations" },
        ],
      },
      candidates: cands, selected, veto: false, urgency: 1 + Math.max(0, 30 - w.startOffset) / 30, expiresAt: addDays(ctx.today, Math.max(3, w.startOffset)),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ PB-02 */
function paceHigh(ctx: Ctx, stats: WindowStat[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const w of stats.slice(3)) {
    if (w.gap === null || w.occupancy === null || w.gap < 0.25 || w.occupancy < 0.55) continue;
    const horizonFree = ctx.days.filter((d) => d.state === "FREE" && d.date >= w.from && !ctx.claimed.has(d.date) && d.priceCents !== null).map((d) => d.date);
    const winFree = w.freeDates.filter((d) => !ctx.claimed.has(d));
    if (horizonFree.length < 4) continue;
    const channel = ctx.refChannel, los = Math.max(ctx.refLos, ctx.strategy.minStay ?? 1, 1);
    const a = avgDay(ctx, horizonFree);
    const promoFn = (d: ISODate) => promosOn(ctx.promos, channel, d);
    const promos = refPromos(ctx, channel, horizonFree), cur = stack(ctx, channel, los, a.price!, promos);
    const df = Math.min(2.5, Math.max(1, w.occupancy / (w.marketOccupancy || w.occupancy)));
    const b0 = expected(ctx, horizonFree, channel, 1, promoFn, los, df), b1 = expected(ctx, horizonFree, channel, 1.05, promoFn, los, df);
    const lastFree = addDays(horizonFree[horizonFree.length - 1], 1);
    const cands: Candidate[] = [finalize(ctx, {
      type: "BASE_PRICE_CHANGE", label: "Relever le prix de base de 5 %",
      detail: `S'applique aux ${horizonFree.length} nuits encore libres à partir du ${fmtDay(w.from)} ; les réservations acquises ne changent pas.`, agent: "pricing",
      target: { system: "PRICELABS" }, parameters: { changePct: 5, basePriceCents: ctx.strategy.basePriceCents ? Math.round(ctx.strategy.basePriceCents * 1.05) : null, dates: horizonFree }, nightsTouched: horizonFree.length, priceChangePct: 5,
      current: cur, proposed: stack(ctx, channel, los, a.price! * 1.05, promos), expectedDeltaCents: b0 !== null && b1 !== null ? b1 - b0 : null,
      hypothesis: `${DEMAND_MODEL_NOTE} La demande propre au logement est estimée par son avance sur le marché.`, rollbackPlan: "Rétablir le prix de base précédent ; fenêtre d'observation minimale de 14 jours.", executionMode: plExec(ctx), risk: "HIGH", measurementWindowDays: 21,
    }, w.from, lastFree)];
    if (winFree.length >= 1) {
      const w0 = expected(ctx, winFree, channel, 1, promoFn, los, df), w1 = expected(ctx, winFree, channel, 1.05, promoFn, los, df);
      const aw = avgDay(ctx, winFree);
      cands.push(finalize(ctx, {
        type: "PRICE_OVERRIDE", label: `Relever de 5 % les ${plural(winFree.length, "nuit")} libre${winFree.length > 1 ? "s" : ""} de la fenêtre`,
        detail: `Action limitée à ${w.label} : le prix de base reste inchangé.`, agent: "pricing",
        target: { system: "PRICELABS" }, parameters: { changePct: 5, nightlyCents: Math.round(aw.price! * 1.05), dates: winFree }, nightsTouched: winFree.length, priceChangePct: 5,
        current: stack(ctx, channel, los, aw.price!, promos), proposed: stack(ctx, channel, los, aw.price! * 1.05, promos), expectedDeltaCents: w0 !== null && w1 !== null ? w1 - w0 : null,
        hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Supprimer les prix datés : PriceLabs reprend son calcul.", executionMode: plExec(ctx), risk: "MEDIUM", measurementWindowDays: 14,
      }, w.from, w.to));
    }
    cands.push(noAction(ctx, w.from, w.to, cur, "Conserver le prix de base et vérifier le rythme à la prochaine revue hebdomadaire."));
    horizonFree.forEach((d) => ctx.claimed.add(d));
    out.push({
      playbook: "PB-02", dedupe: "base", reasonCode: "PACE_ABOVE_MARKET",
      title: `Réservations très en avance sur le marché sur ${w.label}`,
      stayFrom: w.from, stayTo: w.to,
      signalText: `Occupation ${pct(w.occupancy)} pour un marché à ${pct(w.marketOccupancy)}, à plus de ${w.startOffset} jours`, signalSource: `${srcCal(ctx)} + ${srcMkt(ctx)}`,
      hypothesisText: "Le logement se remplit bien plus tôt que son marché : le prix de base est probablement trop bas à cet horizon.",
      signals: { propertyOccupancy: w.occupancy, marketOccupancy: w.marketOccupancy, paceGapPoints: Math.round(w.gap * 100), pricePercentile: a.pctl, freeNightsHorizon: horizonFree.length },
      diagnosis: {
        primary: "BASE_PRICE_LOW", primaryLabel: "Prix de base trop bas pour la demande lointaine",
        alternatives: [
          { cause: "EVENT_NOT_PRICED", label: "Événement mal capturé", why: "Aucun événement déclaré sur la fenêtre : écartée, à revérifier si une date précise concentre les réservations." },
          { cause: "DEMAND_WEAK", label: "Changement de mix de canaux", why: "Un séjour long unique peut produire le même signal : vérifier la durée des réservations acquises." },
        ],
        confidence: confidence([[w.gap >= 0.35, 0.1], [a.pctl !== null && a.pctl <= 50, 0.08], [ctx.lead !== null, 0.05]]),
        confidenceNote: "Signal net, mais quelques séjours longs suffisent à le produire : confiance modérée.",
        tree: [
          { question: "Les réservations arrivent-elles plus tôt que sur le marché ?", answer: `Oui : ${pct(w.occupancy)} contre ${pct(w.marketOccupancy)}.`, verdict: "oui" },
          { question: "Un événement explique-t-il l'avance ?", answer: "Aucun événement déclaré sur la fenêtre.", verdict: "non" },
          { question: "Le prix est-il au-dessus du marché ?", answer: a.pctl === null ? "Position inconnue." : `${Math.round(a.pctl)}e percentile.`, verdict: a.pctl === null ? "inconnu" : a.pctl >= 65 ? "oui" : "non" },
        ],
        evidence: [
          { kind: "fait", label: "Occupation du logement", value: `${pct(w.occupancy)} · ${w.booked} nuits sur ${w.available}`, source: srcCal(ctx) },
          { kind: "comparaison", label: "Occupation du marché", value: pct(w.marketOccupancy), source: srcMkt(ctx) },
          { kind: "fait", label: "Prix de base en vigueur", value: euro(ctx.strategy.basePriceCents), source: "Stratégie" },
          { kind: "comparaison", label: "Position de prix des nuits libres", value: a.pctl === null ? "inconnue" : `${Math.round(a.pctl)}e percentile`, source: srcMkt(ctx) },
        ],
      },
      candidates: cands, selected: pick(cands), veto: false, urgency: 1, expiresAt: addDays(ctx.today, 14),
    });
    break; // une seule hypothèse structurante à la fois par logement
  }
  return out;
}

/* ------------------------------------------------------------------ PB-10 */
function dataDrift(ctx: Ctx): DetectedOpportunity[] {
  return ctx.stale.map((channel) => {
    const ps = ctx.promos.filter((p) => p.channel === channel);
    const oldest = ps.map((p) => p.verifiedAt).filter((x): x is Date => !!x).sort((a, b) => +a - +b)[0];
    const age = oldest ? Math.floor((+ctx.now - +oldest) / 86400000) : null;
    const from = ctx.today, to = addDays(ctx.today, 30);
    const cands: Candidate[] = [
      finalize(ctx, {
        type: "INVESTIGATION", label: `Vérifier les promotions actives dans l'extranet ${CHANNEL_LABEL[channel]}`,
        detail: "Relever chaque promotion, ses dates et son taux, puis confirmer le registre. Aucune remise n'est modifiée.", agent: "distribution",
        target: { system: channel, channel }, parameters: { promotions: ps.map((p) => p.label), channel }, nightsTouched: 0, priceChangePct: null, current: null, proposed: null,
        expectedDeltaCents: null, hypothesis: "Non chiffrable : il s'agit de rétablir une donnée, pas de produire un revenu.",
        rollbackPlan: "Aucune écriture externe : rien à annuler.", executionMode: "MANUAL_RUNBOOK", risk: "LOW", measurementWindowDays: 0,
      }, from, to),
    ];
    return {
      playbook: "PB-10", dedupe: channel, reasonCode: "DATA_STALE",
      title: `Registre des promotions ${CHANNEL_LABEL[channel]} non vérifié depuis ${age === null ? "une date inconnue" : age + " jours"}`,
      stayFrom: from, stayTo: to,
      signalText: `${plural(ps.length, "promotion")} déclarée${ps.length > 1 ? "s" : ""}, dernière vérification ${age === null ? "inconnue" : "il y a " + age + " jours"} (seuil : 7 jours)`, signalSource: `Registre des promotions ${CHANNEL_LABEL[channel]}`,
      hypothesisText: "Sans vérification récente, le cumul réel des remises sur ce canal est incertain.",
      signals: { channel, promotions: ps.length, ageDays: age },
      diagnosis: {
        primary: "DATA_STALE", primaryLabel: "Donnée de canal trop ancienne pour décider",
        alternatives: [], confidence: 0.9, confidenceNote: "Constat d'horodatage.",
        tree: [{ question: "Les promotions ont-elles été vérifiées depuis moins de 7 jours ?", answer: age === null ? "Aucune vérification enregistrée." : `Non : ${age} jours.`, verdict: "non" }],
        evidence: ps.map((p) => ({ kind: "fait" as const, label: p.label, value: `−${p.discountPct} % · vérifiée ${p.verifiedAt ? "il y a " + Math.floor((+ctx.now - +p.verifiedAt) / 86400000) + " j" : "jamais"}`, source: `Registre ${CHANNEL_LABEL[channel]}` })),
      },
      candidates: cands, selected: 0, veto: false, urgency: 1.2, expiresAt: to,
    } satisfies DetectedOpportunity;
  });
}

/* ------------------------------------------------------------------ entrée */
export type EngineResult = { opportunities: DetectedOpportunity[]; stats: WindowStat[]; blocked: string[]; /** Canaux exclus de la revue faute de majoration renseignée */ missingMarkups: Channel[] };

/**
 * Revue déterministe d'un logement : signaux → diagnostic → options → simulation → audit.
 * Si le modèle économique est incomplet, aucune opportunité financière n'est ouverte :
 * une donnée absente bloque, elle ne vaut pas zéro.
 */
export function reviewProperty(input: EngineInput): EngineResult {
  const stats = windowStats(input.days, input.today);
  const blocked = missingEconomics(input.model);
  if (blocked.length) return { opportunities: [], stats, blocked, missingMarkups: [] };
  const declared = Object.keys(input.model.channels) as Channel[];
  // une majoration inconnue n'est jamais traitée comme 0 % : le canal est exclu et l'application demande de la saisir
  const missingMarkups = input.markups ? declared.filter((c) => input.markups![c] === undefined || input.markups![c] === null) : [];
  const channels = declared.filter((c) => !missingMarkups.includes(c));
  if (channels.length === 0) return { opportunities: [], stats, blocked: [], missingMarkups };
  const share = channelShare(input.resas);
  const refChannel = [...channels].sort((a, b) => (input.model.channels[b]!.commissionPct + input.model.channels[b]!.paymentFeePct) - (input.model.channels[a]!.commissionPct + input.model.channels[a]!.paymentFeePct))[0];
  const stale = channels.filter((c) => {
    const ps = input.promos.filter((p) => p.channel === c);
    return ps.length > 0 && ps.some((p) => !p.verifiedAt || +input.now - +p.verifiedAt > 7 * 86400000);
  });
  const ctx: Ctx = {
    ...input, byDate: new Map(input.days.map((d) => [d.date, d])), channels, refChannel, refLos: medianLos(input.resas) ?? Math.max(input.strategy.minStay ?? 2, 2),
    lead: leadTimes(input.resas), share, claimed: new Set(), stale,
    audit: { model: input.model, strategy: input.strategy, stalePromoChannels: stale, conflict: false, capabilities: input.capabilities, demo: input.property.isDemo, promos: input.promos, window: { from: input.today, to: input.today } },
  };
  const opportunities = [...floorBreach(ctx), ...minPriceBelowFloor(ctx), ...stackRisk(ctx), ...orphanGaps(ctx), ...eventUplift(ctx), ...paceHigh(ctx, stats), ...paceLow(ctx, stats), ...dataDrift(ctx)];
  return { opportunities, stats, blocked: [], missingMarkups };
}

/** Score de priorité (blueprint §9.2). Il organise le travail ; il ne contourne jamais un veto. */
export function priorityScore(o: DetectedOpportunity): number {
  const c = o.candidates[o.selected];
  const impact = Math.max(0, c?.expectedDeltaCents ?? 0) / 100;
  const riskPenalty = { LOW: 0, MEDIUM: 4, HIGH: 10, CRITICAL: 25 }[c?.risk ?? "LOW"];
  return Math.round((impact * o.diagnosis.confidence * o.urgency - riskPenalty + (o.veto ? 10000 : 0)) * 10) / 10;
}
