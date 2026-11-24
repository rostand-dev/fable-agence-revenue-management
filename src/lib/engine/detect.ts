import { apiWriteSupports } from "../integrations/pricelabs-write-types";
import { addDays, diffDays, fmtDay, type ISODate } from "../dates";
import { euro, pct } from "../format";
import { auditCandidate } from "./audit";
import { avgDay, expected, fmtPctFr, markupFactor, markupPctOf, overlaps, plural, promosOn, runs, stack, type Ctx, type EngineInput } from "./context";
import { DEMAND_MODEL_NOTE, sellProbability } from "./demand";
import { cumulativeDiscountPct, hardFloorCents, missingEconomics } from "./economics";
import { PLAYBOOKS, threshold } from "./playbooks";
import { DEFAULT_SCORING, priorityScoreWith } from "./scoring";
import { conformOpportunity, type ConformityIssue } from "./candidates";
import { strategyFloorOver } from "./seasons";
import {
  detectCancellation, detectChannelGap, detectDataDrift, detectEventUplift, detectFloorBreach, detectMinPriceBelowFloor, detectOrphanGap, detectPaceHigh, detectPaceLow, detectStackRisk, summarize,
  type CancellationPayload, type ChannelGapPayload, type DataDriftPayload, type EventUpliftPayload, type FloorBreachPayload, type MinPricePayload, type OrphanGapPayload, type PaceHighPayload, type PaceLowPayload, type Signal, type StackRiskPayload,
} from "./signals";
import { channelShare, leadTimes, medianLos, windowStats, type WindowStat } from "./metrics";
import type { Candidate, Channel, DetectedOpportunity, Diagnosis, DiagnosisStep, Evidence, Promo, StackResult } from "./types";
import { CHANNEL_LABEL } from "./types";

// Compatibilité : ces symboles vivaient ici avant l'extraction du contexte (`context.ts`).
export { markupFactor, promosOn };
export type { EngineInput };

function finalize(ctx: Ctx, draft: Omit<Candidate, "audit">, from: ISODate, to: ISODate): Candidate {
  return { ...draft, audit: auditCandidate(draft, { ...ctx.audit, window: { from, to }, conflict: draft.type !== "NO_ACTION" && draft.type !== "MIN_PRICE_CHANGE" && draft.type !== "INVESTIGATION" && overlaps(ctx, from, to) }) };
}
/** Écriture PriceLabs par API seulement si la capacité existe pour ce logement (US-002) ; sinon procédure manuelle guidée. */
/** Écriture par API seulement si la capacité est ouverte ET si ce type d'action s'écrit par API (sur un logement réel, voir API_WRITE_TYPES) ; sinon procédure manuelle. */
/** Prix de la grille locale sur lesquels la simulation s'est appuyée, figés dans l'action : l'écriture réelle les compare à l'état chez PriceLabs (US-091) */
const simulatedPrices = (ctx: Ctx, dates: ISODate[]) => Object.fromEntries(dates.map((d) => [d, ctx.byDate.get(d)?.priceCents ?? null]));
const plExec = (ctx: Ctx, type: string): Candidate["executionMode"] => (ctx.capabilities["pricelabs.write"] && apiWriteSupports(type, ctx.property.isDemo) ? "API_PRICELABS" : "MANUAL_RUNBOOK");

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
const srcCal = (ctx: Ctx) => (ctx.property.isDemo ? "Calendrier de démonstration" : "PriceLabs · disponibilités");
const srcMkt = (ctx: Ctx) => (ctx.property.isDemo ? "Marché de démonstration" : "PriceLabs · marché");
const srcPL = (ctx: Ctx) => (ctx.property.isDemo ? "Grille de démonstration" : ctx.priceSource === "SUPERHOTE" ? "SuperHote · calendrier" : "PriceLabs · prix recommandé");

/* ------------------------------------------------------------------ PB-06 */
function floorBreach(ctx: Ctx, signals: Signal<FloorBreachPayload>[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const sig of signals) {
    const { run, channel, los } = sig.payload;
    const from = sig.from, to = sig.to;
    const a = avgDay(ctx, run); const price = a.price!;
    const promos = refPromos(ctx, channel, run);
    const cur = stack(ctx, channel, los, price, promos);
    const hard = hardFloorCents(ctx.model, channel, los), strat = strategyFloorOver(ctx.model, channel, los, from, to);
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
        hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Réactiver la règle sur les dates concernées.", executionMode: plExec(ctx, "RULE_EXCLUSION"), risk: "MEDIUM", measurementWindowDays: 7,
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
        hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Supprimer le prix daté : PriceLabs reprend son calcul.", executionMode: plExec(ctx, "PRICE_OVERRIDE"), risk: "MEDIUM", measurementWindowDays: 7,
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
      playbook: "PB-06", signal: summarize(sig, ctx.today), reasonCode: "FLOOR_BREACH",
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

/* ------------------------------------------------------------------ PB-13 */
/**
 * PB-13 · minimum PriceLabs sous le plancher (extension du catalogue : le blueprint §9.5 s'arrête à PB-12).
 * PB-11 reste réservé au playbook du blueprint « BASE_LOW » (hausse graduelle du prix de base), pas encore implémenté.
 *
 * Le prix minimum PriceLabs est un plancher mécanique : tant que minimum × (1 + majoration) passe sous le plancher absolu d'un canal,
 * PriceLabs peut vendre sous ce plancher dès que la demande baisse. L'agent d'onboarding propose de relever ce minimum.
 * Il ne se déclenche jamais pour un canal dont la majoration est inconnue (ce canal est exclu de la revue).
 */
function minPriceBelowFloor(ctx: Ctx, signals: Signal<MinPricePayload>[]): DetectedOpportunity[] {
  const sig = signals[0];
  if (!sig) return [];
  const { channel, los, minCents: min, hardCents, needed, current } = sig.payload;
  const w = { ch: channel, cur: current, hard: hardCents, need: needed }, newMin = w.need, from = sig.from, to = sig.to;
  const mk = markupFactor(ctx.markups, w.ch), name = CHANNEL_LABEL[w.ch];
  const proposed = stack(ctx, w.ch, los, newMin, []);
  const cands: Candidate[] = [
    finalize(ctx, {
      type: "MIN_PRICE_CHANGE", label: `Relever le prix minimum PriceLabs à ${euro(newMin)}`,
      detail: `Plus petit minimum entier dont le prix vendu ${name} atteint le plancher absolu de ${euro(w.hard)}${ctx.markups ? `, majoration de ${fmtPctFr(markupPctOf(ctx, w.ch))} comprise` : ""}. Aucun prix daté n'est posé : seule la limite basse change.`, agent: "onboarding",
      target: { system: "PRICELABS" }, parameters: { minPriceCents: newMin, previousMinPriceCents: min, restoresFloor: true, channel: w.ch }, nightsTouched: 0, priceChangePct: (newMin / min - 1) * 100,
      current: w.cur, proposed, expectedDeltaCents: null,
      hypothesis: "Constat de calcul : il ne dépend d'aucune hypothèse de demande. Relever le minimum peut réduire les ventes les jours où PriceLabs descendrait à cette limite.",
      rollbackPlan: `Remettre le prix minimum à ${euro(min)} dans PriceLabs.`, executionMode: plExec(ctx, "MIN_PRICE_CHANGE"), risk: "MEDIUM", measurementWindowDays: 14,
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
    playbook: "PB-13", signal: summarize(sig, ctx.today), dedupe: "min", reasonCode: "MIN_PRICE_BELOW_FLOOR",
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
function stackRisk(ctx: Ctx, signals: Signal<StackRiskPayload>[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const sig of signals) {
      const { channel, run, los } = sig.payload;
      const from = sig.from, to = sig.to;
      const price = avgDay(ctx, run).price!;
      const promos = refPromos(ctx, channel, run);
      const cur = stack(ctx, channel, los, price, promos);
      const strat = strategyFloorOver(ctx.model, channel, los, from, to);
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
        playbook: "PB-05", signal: summarize(sig, ctx.today), reasonCode: "DISCOUNT_STACK_RISK",
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
  return out;
}

/* ------------------------------------------------------------------ PB-03 */
function orphanGaps(ctx: Ctx, signals: Signal<OrphanGapPayload>[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const sig of signals) {
    const { run, minStay, channel, price } = sig.payload;
    const a = avgDay(ctx, run);
    const from = sig.from, to = sig.to, L = run.length;
    const promos = refPromos(ctx, channel, run);
    const proposed = stack(ctx, channel, L, price, promos);
    const p = a.occ !== null && a.pctl !== null ? sellProbability(a.occ, a.pctl) : null;
    const cands: Candidate[] = [
      finalize(ctx, {
        type: "MIN_STAY_OVERRIDE", label: `Ramener le séjour minimum à ${plural(L, "nuit")} sur ces dates`,
        detail: `Les ${plural(L, "nuit")} deviennent réservables au prix publié de ${euro(price)} ; aucun prix n'est modifié.`, agent: "pricing",
        target: { system: "PRICELABS" }, parameters: { minStay: L, previousMinStay: minStay, dates: run }, nightsTouched: L, priceChangePct: null,
        current: null, proposed, expectedDeltaCents: p === null ? null : Math.round(p * proposed.contributionCents),
        hypothesis: p === null ? "Probabilité de vente inconnue : données de marché absentes." : `Contribution d'un séjour de ${plural(L, "nuit")} (${euro(proposed.contributionCents)}) × probabilité de vente approchée (${pct(p)}). ${DEMAND_MODEL_NOTE}`,
        rollbackPlan: `Rétablir le séjour minimum à ${minStay} nuits sur ces dates.`, executionMode: plExec(ctx, "MIN_STAY_OVERRIDE"), risk: "LOW", measurementWindowDays: 7,
      }, from, to),
      noAction(ctx, from, to, null, "Laisser le trou invendable : les nuits restent bloquées par le séjour minimum."),
    ];
    out.push({
      playbook: "PB-03", signal: summarize(sig, ctx.today), reasonCode: "ORPHAN_GAP",
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
function eventUplift(ctx: Ctx, signals: Signal<EventUpliftPayload>[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const sig of signals) {
    const run = sig.payload.run;
    const from = sig.from, to = sig.to, channel = ctx.refChannel, los = Math.max(Math.min(ctx.refLos, run.length), ctx.strategy.minStay ?? 1, 1);
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
        target: { system: "PRICELABS" }, parameters: { changePct: up, nightlyCents: Math.round(capped), dates: run, simulatedPrices: simulatedPrices(ctx, run) }, nightsTouched: run.length, priceChangePct: up,
        current: cur, proposed: stack(ctx, channel, los, capped, promos), expectedDeltaCents: base !== null && e !== null ? e - base : null,
        hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Supprimer le prix daté : PriceLabs reprend son calcul.", executionMode: plExec(ctx, "PRICE_OVERRIDE"), risk: "MEDIUM", measurementWindowDays: 14,
      }, from, to);
    };
    const cands = [mk(12), mk(5), noAction(ctx, from, to, cur, "Laisser PriceLabs ajuster seul à l'approche de la date.")];
    out.push({
      playbook: "PB-07", signal: summarize(sig, ctx.today), reasonCode: "EVENT_UPLIFT",
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
function paceLow(ctx: Ctx, signals: Signal<PaceLowPayload>[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const sig of signals) {
    const { window: w, free } = sig.payload;
    const a = avgDay(ctx, free);
    if (a.price === null || a.occ === null) continue;
    const from = w.from, to = w.to, channel = ctx.refChannel, los = Math.max(ctx.refLos, ctx.strategy.minStay ?? 1, 1);
    const notOpen = ctx.lead !== null && w.startOffset > ctx.lead.p75;
    const weak = a.occ < threshold("PB-01", "weakMarketOccupancy");
    const priceHigh = a.pctl !== null && a.pctl >= threshold("PB-01", "priceHighPercentile");
    const restr = a.minStay !== null && a.minStay >= threshold("PB-01", "restrictiveMinStay") && a.minStay > ctx.refLos;
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
    const target = free.slice(0, threshold("PB-01", "maxTargetNights"));
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
      target: { system: "PRICELABS" }, parameters: { changePct: -5, nightlyCents: Math.round(a.price * 0.95), dates: target, simulatedPrices: simulatedPrices(ctx, target) }, nightsTouched: target.length, priceChangePct: -5,
      current: cur, proposed: stack(ctx, channel, los, a.price * 0.95, promos), expectedDeltaCents: base !== null && eDown !== null ? eDown - base : null,
      hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Supprimer les prix datés : PriceLabs reprend son calcul.", executionMode: plExec(ctx, "PRICE_OVERRIDE"), risk: "MEDIUM", measurementWindowDays: 7,
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
      playbook: "PB-01", signal: summarize(sig, ctx.today), dedupe: w.key, reasonCode: preferNo ? "PACE_BELOW_MARKET_EXPECTED" : "PACE_BELOW_MARKET",
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
function paceHigh(ctx: Ctx, signals: Signal<PaceHighPayload>[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const sig of signals) {
    const { window: w, horizonFree, winFree } = sig.payload;
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
      target: { system: "PRICELABS" }, parameters: { changePct: 5, basePriceCents: ctx.strategy.basePriceCents ? Math.round(ctx.strategy.basePriceCents * 1.05) : null, previousBasePriceCents: ctx.strategy.basePriceCents ?? null, dates: horizonFree }, nightsTouched: horizonFree.length, priceChangePct: 5,
      current: cur, proposed: stack(ctx, channel, los, a.price! * 1.05, promos), expectedDeltaCents: b0 !== null && b1 !== null ? b1 - b0 : null,
      hypothesis: `${DEMAND_MODEL_NOTE} La demande propre au logement est estimée par son avance sur le marché.`, rollbackPlan: "Rétablir le prix de base précédent ; fenêtre d'observation minimale de 14 jours.", executionMode: ctx.property.isDemo || ctx.strategy.basePriceCents ? plExec(ctx, "BASE_PRICE_CHANGE") : "MANUAL_RUNBOOK", risk: "HIGH", measurementWindowDays: 21,
    }, w.from, lastFree)];
    if (winFree.length >= 1) {
      const w0 = expected(ctx, winFree, channel, 1, promoFn, los, df), w1 = expected(ctx, winFree, channel, 1.05, promoFn, los, df);
      const aw = avgDay(ctx, winFree);
      cands.push(finalize(ctx, {
        type: "PRICE_OVERRIDE", label: `Relever de 5 % les ${plural(winFree.length, "nuit")} libre${winFree.length > 1 ? "s" : ""} de la fenêtre`,
        detail: `Action limitée à ${w.label} : le prix de base reste inchangé.`, agent: "pricing",
        target: { system: "PRICELABS" }, parameters: { changePct: 5, nightlyCents: Math.round(aw.price! * 1.05), dates: winFree, simulatedPrices: simulatedPrices(ctx, winFree) }, nightsTouched: winFree.length, priceChangePct: 5,
        current: stack(ctx, channel, los, aw.price!, promos), proposed: stack(ctx, channel, los, aw.price! * 1.05, promos), expectedDeltaCents: w0 !== null && w1 !== null ? w1 - w0 : null,
        hypothesis: DEMAND_MODEL_NOTE, rollbackPlan: "Supprimer les prix datés : PriceLabs reprend son calcul.", executionMode: plExec(ctx, "PRICE_OVERRIDE"), risk: "MEDIUM", measurementWindowDays: 14,
      }, w.from, w.to));
    }
    cands.push(noAction(ctx, w.from, w.to, cur, "Conserver le prix de base et vérifier le rythme à la prochaine revue hebdomadaire."));
    out.push({
      playbook: "PB-02", signal: summarize(sig, ctx.today), dedupe: "base", reasonCode: "PACE_ABOVE_MARKET",
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
  }
  return out;
}

/* ------------------------------------------------------------------ PB-04 */
/**
 * PB-04 · un canal sous-performe. Le logement suit son marché dans son ensemble, mais un canal pèse nettement moins dans les nuits déjà réservées
 * qu'il ne pèse d'habitude. Le diagnostic reste ouvert : visibilité, promotion absente ou inventaire non distribué ne se distinguent pas sans accès
 * partenaire. L'option retenue est donc l'audit de l'annonce quand une promotion est déjà active sur ce canal (jamais deux remises pour un même signal),
 * sinon la meilleure espérance, et l'inaction quand le gain attendu est faible.
 */
function channelGap(ctx: Ctx, signals: Signal<ChannelGapPayload>[]): DetectedOpportunity[] {
  const out: DetectedOpportunity[] = [];
  for (const sig of signals) {
    const { channel, onBooksShare, historicalShare, onBooksNights, historyStays } = sig.payload;
    const target = sig.dates, from = sig.from, to = sig.to, name = CHANNEL_LABEL[channel];
    const los = Math.max(ctx.refLos, ctx.strategy.minStay ?? 1, 1);
    const a = avgDay(ctx, target);
    if (a.price === null) continue;
    const promos = refPromos(ctx, channel, target);
    const promoFn = (d: ISODate) => promosOn(ctx.promos, channel, d);
    const cur = stack(ctx, channel, los, a.price, promos);
    const kind = channel === "BOOKING" ? { kind: "MOBILE", label: "Offre mobile ciblée" } : { kind: "LAST_MINUTE", label: "Remise dernière minute" };
    const add = { label: kind.label, discountPct: 10 };
    const next = stack(ctx, channel, los, a.price, [...promos, add]);
    const b0 = expected(ctx, target, channel, 1, promoFn, los);
    const b1 = expected(ctx, target, channel, 1, (d) => [...promoFn(d), add], los);
    const cands: Candidate[] = [
      finalize(ctx, {
        type: "CHANNEL_PROMO", label: `${kind.label} ${name} à 10 % sur la fenêtre`,
        detail: `Remise limitée à ${name}, séjours du ${fmtDay(from)} au ${fmtDay(to)} ; le prix de l'autre canal reste inchangé.`, agent: "distribution",
        target: { system: channel, channel }, parameters: { kind: kind.kind, discountPct: 10, label: kind.label, stayFrom: from, stayTo: to }, nightsTouched: target.length, priceChangePct: null,
        current: cur, proposed: next, expectedDeltaCents: b0 !== null && b1 !== null ? Math.round((b1 - b0) * (ctx.share[channel] ?? 0.5)) : null,
        hypothesis: `${DEMAND_MODEL_NOTE} Écart pondéré par la part habituelle du canal (${pct(historicalShare)}) ; le gain de visibilité propre à la promotion n'est pas chiffré, et la distribution de l'inventaire sur ce canal n'est pas vérifiable sans accès partenaire.`,
        rollbackPlan: `Désactiver la promotion dans l'extranet ${name}.`, executionMode: "MANUAL_RUNBOOK", risk: "MEDIUM", measurementWindowDays: 14,
      }, from, to),
      finalize(ctx, {
        type: "LISTING_AUDIT", label: `Auditer l'annonce ${name} avant toute remise`,
        detail: `Contrôle du titre, des photos, des équipements, des avis et de la distribution de l'inventaire sur ${name}.`, agent: "annonce",
        target: { system: "INTERNAL" }, parameters: { channel }, nightsTouched: 0, priceChangePct: null, current: cur, proposed: null, expectedDeltaCents: null,
        hypothesis: "Effet non chiffrable : aucun taux de conversion par canal n'est disponible sans accès partenaire.", rollbackPlan: "Aucune écriture externe : rien à annuler.",
        executionMode: "INTERNAL", risk: "LOW", measurementWindowDays: 14,
      }, from, to),
      noAction(ctx, from, to, cur, `Attendre une revue supplémentaire : l'écart de part peut venir de quelques séjours longs sur l'autre canal.`, 7),
    ];
    const promoActive = promos.length > 0;
    const selected = pick(cands, { forceType: promoActive ? "LISTING_AUDIT" : undefined });
    out.push({
      playbook: "PB-04", signal: summarize(sig, ctx.today), dedupe: channel, reasonCode: "CHANNEL_UNDERPERFORMS",
      title: `${name} pèse ${Math.round((historicalShare - onBooksShare) * 100)} points de moins que d'habitude dans les nuits réservées`,
      stayFrom: from, stayTo: to,
      signalText: `${name} : ${pct(onBooksShare)} des nuits réservées sur ${threshold("PB-04", "horizonDays")} jours contre ${pct(historicalShare)} d'habitude`, signalSource: "Historique et réservations à venir",
      hypothesisText: "Le canal est moins visible ou moins attractif qu'avant ; l'ensemble du logement suit pourtant son marché.",
      signals: { channel, onBooksShare: Math.round(onBooksShare * 1000) / 1000, historicalShare: Math.round(historicalShare * 1000) / 1000, onBooksNights, historyStays, freeNights: target.length },
      diagnosis: {
        primary: "VISIBILITY_CONVERSION", primaryLabel: `Visibilité ou conversion de l'annonce sur ${name}`,
        alternatives: [
          { cause: "DISCOUNT_STACK", label: "Promotion absente ou déjà active", why: promoActive ? `Plausible : ${promos.map((p) => `${p.label} ${p.discountPct} %`).join(", ")} déjà active${promos.length > 1 ? "s" : ""} sur le canal ; une remise de plus s'ajouterait.` : "Aucune promotion active relevée sur le canal : une offre ciblée est possible." },
          { cause: "PRICE_HIGH", label: "Prix publié plus haut sur ce canal", why: ctx.markups ? `Majoration ${name} de ${fmtPctFr(markupPctOf(ctx, channel))} : le prix publié du canal est plus élevé que celui de l'autre.` : "Non vérifiable : majoration du canal inconnue." },
        ],
        confidence: confidence([[historyStays >= 24, 0.08], [onBooksNights >= 20, 0.06], [!ctx.stale.includes(channel), 0.06]], 0.4),
        confidenceNote: "Diagnostic par comparaison de parts de canal : aucune mesure directe de visibilité ni de conversion.",
        tree: [
          { question: "Le problème est-il propre à un canal ?", answer: `Oui : ${name} perd ${Math.round((historicalShare - onBooksShare) * 100)} points de part, le logement suit son marché.`, verdict: "oui" },
          { question: "Une promotion est-elle déjà active sur ce canal ?", answer: promoActive ? promos.map((p) => `${p.label} (${p.discountPct} %)`).join(", ") + "." : "Aucune promotion active relevée.", verdict: promoActive ? "oui" : "non" },
          { question: "L'inventaire est-il bien distribué sur ce canal ?", answer: "Inconnu : non vérifiable sans accès partenaire.", verdict: "inconnu" },
        ],
        evidence: [
          { kind: "fait", label: `Part de ${name} dans les nuits réservées à venir`, value: `${pct(onBooksShare)} (${onBooksNights} nuits)`, source: "Réservations SuperHote" },
          { kind: "comparaison", label: `Part habituelle de ${name}`, value: `${pct(historicalShare)} (${historyStays} séjours sur douze mois)`, source: "Historique des réservations" },
          { kind: "fait", label: "Prix publié moyen des nuits libres", value: euro(a.price), source: srcPL(ctx) },
        ],
      },
      candidates: cands, selected, veto: false, urgency: 1 + Math.max(0, 30 - diffDays(from, ctx.today)) / 60, expiresAt: addDays(ctx.today, 14),
    });
  }
  return out;
}
/* ------------------------------------------------------------------ PB-08 */
/**
 * PB-08 · une annulation rouvre des nuits. Le dossier demande une relecture (calendrier, prix publié, promotions du canal) et n'engage ni remise ni baisse de prix :
 * la nuit rouverte retrouve sa chance de se vendre au prix courant, et la baisser dans la foulée serait une réaction, pas un diagnostic (§9.5).
 * L'inaction reste proposée ; elle est retenue quand les nuits sont lointaines.
 */
function cancellation(ctx: Ctx, signals: Signal<CancellationPayload>[]): DetectedOpportunity[] {
  return signals.map((sig) => {
    const { channel, checkIn, checkOut, cancelledAt, stayNights, reopened, cancelled14, rate14 } = sig.payload;
    const from = sig.from, to = sig.to, name = (CHANNEL_LABEL as Record<string, string>)[channel] ?? channel;
    const alert = threshold("PB-08", "alertRate"), rateDays = threshold("PB-08", "rateWindowDays"), series = rate14 !== null && rate14 >= alert;
    const lead = diffDays(from, ctx.today), noActionLead = threshold("PB-08", "noActionLeadDays");
    const cands: Candidate[] = [
      finalize(ctx, {
        type: "INVESTIGATION", label: `Relire le calendrier et les promotions des ${plural(reopened.length, "nuit")} rouverte${reopened.length > 1 ? "s" : ""}`,
        detail: `Contrôler que les ${plural(reopened.length, "nuit")} rouverte${reopened.length > 1 ? "s" : ""} entre le ${fmtDay(from)} et le ${fmtDay(addDays(to, -1))} sont bien ouvertes sur tous les canaux, que leur prix et leurs restrictions sont cohérents, et quelles promotions les couvrent. Aucun prix ni aucune remise n'est modifié.`, agent: "distribution",
        // « subject » distingue cette relecture du calendrier de la vérification du registre des promotions (PB-10) : elle ne le date pas comme vérifié
        target: { system: "INTERNAL" }, parameters: { channel, subject: "CALENDAR", checkIn, checkOut, nights: reopened.length, dates: reopened }, nightsTouched: 0, priceChangePct: null, current: null, proposed: null, expectedDeltaCents: null,
        hypothesis: "Non chiffrable : il s'agit de vérifier que les nuits rouvertes sont bien proposées, pas de produire un revenu.",
        rollbackPlan: "Aucune écriture externe : rien à annuler.", executionMode: "MANUAL_RUNBOOK", risk: "LOW", measurementWindowDays: PLAYBOOKS["PB-08"].measurementHorizonDays,
      }, from, to),
      noAction(ctx, from, to, null, lead > noActionLead ? "Les nuits rouvertes retrouvent leur chance de se vendre au prix courant, et la fenêtre est encore lointaine : attendre avant toute réaction." : "Les nuits rouvertes retrouvent leur chance de se vendre au prix courant : attendre la prochaine revue plutôt que réagir à une seule annulation.", 3),
    ];
    return {
      playbook: "PB-08", signal: summarize(sig, ctx.today), dedupe: sig.dedupe ?? undefined, reasonCode: "DATES_REOPENED",
      title: `Annulation ${name} : ${plural(reopened.length, "nuit")} rouverte${reopened.length > 1 ? "s" : ""} du ${fmtDay(from)} au ${fmtDay(to)}`,
      stayFrom: from, stayTo: to,
      signalText: `Séjour du ${fmtDay(checkIn)} au ${fmtDay(checkOut)} annulé le ${fmtDay(cancelledAt)} : ${plural(reopened.length, "nuit")} encore libre${reopened.length > 1 ? "s" : ""}`, signalSource: "Historique des réservations SuperHote",
      hypothesisText: series ? "Une série d'annulations rouvre des dates : le motif n'est pas connu, le dossier demande une relecture avant toute décision de prix." : "Une annulation ponctuelle rouvre des dates ; sans série d'annulations, elle ne dit rien du prix.",
      signals: { channel, checkIn, checkOut, cancelledAt, reopenedNights: reopened.length, cancelledStays14d: cancelled14, cancellationRate14d: rate14 === null ? null : Math.round(rate14 * 1000) / 1000 },
      diagnosis: {
        primary: "CANCELLATION", primaryLabel: "Annulation qui rouvre des dates",
        alternatives: [
          { cause: "DEMAND_WEAK", label: "Demande faible à cet horizon", why: "Non établie : une seule annulation ne mesure pas la demande ; les playbooks de rythme (PB-01, PB-02) traitent la demande." },
          { cause: "PRICE_HIGH", label: "Prix trop haut à l'origine de l'annulation", why: "Non vérifiable : le motif de l'annulation n'est pas connu." },
        ],
        confidence: confidence([[reopened.length >= 3, 0.06], [lead <= 30, 0.06], [rate14 !== null, 0.04]], 0.5),
        confidenceNote: "Constat d'une annulation enregistrée par SuperHote ; son motif n'est pas connu.",
        tree: [
          { question: "Des nuits à venir sont-elles rouvertes et encore libres ?", answer: `Oui : ${plural(reopened.length, "nuit")} sur ${plural(stayNights, "nuit")} du séjour annulé.`, verdict: "oui" },
          { question: "S'agit-il d'une série d'annulations ?", answer: rate14 === null ? "Inconnu : historique ou échantillon trop court pour calculer le taux." : `${series ? "Oui" : "Non"} : ${plural(cancelled14 ?? 0, "annulation")} sur ${rateDays} jours, soit ${pct(rate14)} des réservations (alerte à ${pct(alert)}).`, verdict: rate14 === null ? "inconnu" : series ? "oui" : "non" },
          { question: "Le motif de l'annulation est-il connu ?", answer: "Non : SuperHote ne le transmet pas.", verdict: "inconnu" },
        ],
        evidence: [
          { kind: "fait", label: `Séjour annulé (${name})`, value: `${fmtDay(checkIn)} → ${fmtDay(checkOut)}, annulé le ${fmtDay(cancelledAt)}`, source: "Historique des réservations SuperHote" },
          { kind: "fait", label: "Nuits rouvertes encore libres", value: `${fmtDay(from)} → ${fmtDay(to)} (${plural(reopened.length, "nuit")})`, source: srcCal(ctx) },
          ...(rate14 !== null ? [{ kind: "comparaison" as const, label: `Taux d'annulation sur ${rateDays} jours`, value: `${pct(rate14)} (${plural(cancelled14 ?? 0, "annulation")})`, source: "Historique des réservations SuperHote" }] : []),
        ],
      },
      candidates: cands, selected: pick(cands, { forceType: lead > noActionLead ? "NO_ACTION" : "INVESTIGATION" }), veto: false, urgency: 0.8 + (series ? 0.4 : 0) + Math.max(0, 14 - lead) / 40, expiresAt: addDays(ctx.today, threshold("PB-08", "expiryDays")),
    } satisfies DetectedOpportunity;
  });
}
/* ------------------------------------------------------------------ PB-10 */
function dataDrift(ctx: Ctx, signals: Signal<DataDriftPayload>[]): DetectedOpportunity[] {
  return signals.map((sig) => {
    const { channel, ageDays: age } = sig.payload;
    const ps = ctx.promos.filter((p) => p.channel === channel);
    const from = sig.from, to = sig.to;
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
      playbook: "PB-10", signal: summarize(sig, ctx.today), dedupe: channel, reasonCode: "DATA_STALE",
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
export type EngineResult = { opportunities: DetectedOpportunity[]; /** Signaux observés, y compris ceux dont le constructeur n'a rien retenu */ signals: Signal[]; stats: WindowStat[]; blocked: string[]; /** Canaux exclus de la revue faute de majoration renseignée */ missingMarkups: Channel[]; /** Candidates retirées faute de respecter leur contrat (US-063) : doit rester vide */ conformity: ConformityIssue[] };

/**
 * Revue déterministe d'un logement : signaux → diagnostic → options → simulation → audit.
 * Si le modèle économique est incomplet, aucune opportunité financière n'est ouverte :
 * une donnée absente bloque, elle ne vaut pas zéro.
 */
export function reviewProperty(input: EngineInput): EngineResult {
  const stats = windowStats(input.days, input.today);
  const blocked = missingEconomics(input.model);
  if (blocked.length) return { opportunities: [], signals: [], stats, blocked, missingMarkups: [], conformity: [] };
  const declared = Object.keys(input.model.channels) as Channel[];
  // une majoration inconnue n'est jamais traitée comme 0 % : le canal est exclu et l'application demande de la saisir
  const missingMarkups = input.markups ? declared.filter((c) => input.markups![c] === undefined || input.markups![c] === null) : [];
  const channels = declared.filter((c) => !missingMarkups.includes(c));
  if (channels.length === 0) return { opportunities: [], signals: [], stats, blocked: [], missingMarkups, conformity: [] };
  const share = channelShare(input.resas);
  const refChannel = [...channels].sort((a, b) => (input.model.channels[b]!.commissionPct + input.model.channels[b]!.paymentFeePct) - (input.model.channels[a]!.commissionPct + input.model.channels[a]!.paymentFeePct))[0];
  const stale = channels.filter((c) => {
    const ps = input.promos.filter((p) => p.channel === c);
    return ps.length > 0 && ps.some((p) => !p.verifiedAt || +input.now - +p.verifiedAt > 7 * 86400000);
  });
  const ctx: Ctx = {
    ...input, byDate: new Map(input.days.map((d) => [d.date, d])), channels, refChannel, refLos: medianLos(input.resas) ?? Math.max(input.strategy.minStay ?? 2, 2),
    lead: leadTimes(input.resas), share, claimed: new Set(), stale,
    audit: { model: input.model, strategy: input.strategy, stalePromoChannels: stale, conflict: false, capabilities: input.capabilities, demo: input.property.isDemo, promos: input.promos, window: { from: input.today, to: input.today }, recentBaseChanges: input.recentBaseChanges ?? [], structuralHold: input.structuralHold ?? null },
  };
  // chaque règle observe (signals.ts), puis son constructeur instruit : l'ordre est fixe car une règle retire ses nuits aux suivantes
  const signals: Signal[] = [];
  const step = <P,>(found: Signal<P>[], build: (s: Signal<P>[]) => DetectedOpportunity[]) => { signals.push(...(found as Signal[])); return build(found); };
  const built = [
    ...step(detectFloorBreach(ctx), (s) => floorBreach(ctx, s)),
    ...step(detectMinPriceBelowFloor(ctx), (s) => minPriceBelowFloor(ctx, s)),
    ...step(detectStackRisk(ctx), (s) => stackRisk(ctx, s)),
    ...step(detectOrphanGap(ctx), (s) => orphanGaps(ctx, s)),
    ...step(detectEventUplift(ctx), (s) => eventUplift(ctx, s)),
    ...step(detectPaceHigh(ctx, stats), (s) => paceHigh(ctx, s)),
    ...step(detectPaceLow(ctx, stats), (s) => paceLow(ctx, s)),
    ...step(detectChannelGap(ctx, stats), (s) => channelGap(ctx, s)),
    ...step(detectCancellation(ctx), (s) => cancellation(ctx, s)),
    ...step(detectDataDrift(ctx), (s) => dataDrift(ctx, s)),
  ];
  // chaque candidate respecte le contrat de son type et les actions permises par son playbook ; sinon elle est retirée (jamais proposée) et signalée
  const conformity: ConformityIssue[] = [];
  const opportunities = built.flatMap((o) => { const r = conformOpportunity(o); conformity.push(...r.issues); return r.opportunity ? [r.opportunity] : []; });
  return { opportunities, signals, stats, blocked: [], missingMarkups, conformity };
}

/** Score de priorité (blueprint §9.2). Il organise le travail ; il ne contourne jamais un veto. */
export function priorityScore(o: DetectedOpportunity): number {
  return priorityScoreWith(o, DEFAULT_SCORING);
}
