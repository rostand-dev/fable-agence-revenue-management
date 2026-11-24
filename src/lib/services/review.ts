import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "../audit/log";
import { addDays, diffDays, todayISO, type ISODate } from "../dates";
import { MAX_HISTORY_DAYS, type Cancellation } from "../engine/history";
import { cancelledFromChanges } from "../reservations/cancellations";
import { reviewProperty, type EngineInput } from "../engine/detect";
import { PLAYBOOKS } from "../engine/playbooks";
import { DEFAULT_SCORING, resolveScoring, scoreOpportunity, type ScoringConfig } from "../engine/scoring";
import { dedupeOpportunities, groupKeys, openingDecision } from "../engine/lifecycle";
import { groupCooldownUntil, recentBaseChanges, STRUCTURAL_COUNTED_STATUSES, structuralHold } from "../engine/structural";
import type { Channel, Day, DetectedOpportunity, EconomicModel, Promo, Resa, Strategy } from "../engine/types";
import { resolveTargets } from "../agents/llm-config";
import { openBudget } from "../agents/runner";
import { analyzeMarket } from "../agents/market-analyst";
import { PROMPTS } from "../agents/prompts";
import { secondReading, reviewPromptVersion } from "../agents/auditor";
import { applyReview, reviewable, reviewHashOf, type IndependentReview } from "../agents/independent-review";
import { opine, opinionPromptVersion } from "../agents/strategist";
import { deterministicOpinion, deterministicOpinions, factsHashOf, ownedOptions, type AgentOpinion, type StrategistId } from "../agents/strategist-opinions";
import { deterministicAnalysis, evidenceHashOf, type MarketAnalysis } from "../agents/market-analysis";
import { capabilityFlags, capability } from "../integrations/capabilities";
import { freshnessOf } from "../freshness";
import { loadFlags } from "./flags";
import { resolveFlag } from "../flags/catalog";
import { deterministicNarrative, writeNarrative } from "./narrative";
import { measureDueActions } from "./decisions";
import { syncIfStale } from "./pricelabs-sync";

const { properties, calendarDays, marketDays, reservations, promotions, opportunities, revenueActions, agentRuns, integrations, reviewRuns, tenants, reservationChanges } = schema;
const ACTIVE_ACTION = ["APPROVED", "EXECUTING", "EXECUTED", "VERIFIED", "MEASURING"];

/**
 * Majorations saisies par le propriétaire (clé « airbnb », « booking »…) → canaux du moteur. Une majoration non renseignée est `null` (inconnue),
 * jamais 0 % : le moteur exclut alors ce canal de la revue au lieu de calculer un prix vendu faux.
 */
export function channelMarkupsOf(list: { key: string; pct: number | null }[] | null | undefined): Partial<Record<Channel, number | null>> {
  const find = (prefix: string) => (list ?? []).find((m) => m.key === prefix || m.key.startsWith(prefix + "-"));
  const pct = (m: { pct: number | null } | undefined) => (m && typeof m.pct === "number" && Number.isFinite(m.pct) && m.pct >= 0 && m.pct <= 100 ? m.pct : null);
  return { AIRBNB: pct(find("airbnb")), BOOKING: pct(find("booking")) };
}

export async function loadEngineInput(tenantId: string, propertyId: string, today: ISODate, now = new Date()): Promise<EngineInput | null> {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) return null;
  const to = addDays(today, 90);
  const [cal, mkt, resas, promos, ints, acts, baseActs, changes] = await Promise.all([
    db.select().from(calendarDays).where(and(eq(calendarDays.propertyId, p.id), gte(calendarDays.date, today), lte(calendarDays.date, to))),
    db.select().from(marketDays).where(and(eq(marketDays.propertyId, p.id), gte(marketDays.date, today), lte(marketDays.date, to))),
    db.select().from(reservations).where(eq(reservations.propertyId, p.id)),
    db.select().from(promotions).where(and(eq(promotions.propertyId, p.id), eq(promotions.status, "ACTIVE"))),
    db.select().from(integrations).where(eq(integrations.tenantId, tenantId)),
    db.select({ from: opportunities.stayFrom, to: opportunities.stayTo, params: revenueActions.parameters, type: revenueActions.type }).from(revenueActions)
      .innerJoin(opportunities, eq(opportunities.id, revenueActions.opportunityId))
      .where(and(eq(revenueActions.propertyId, p.id), inArray(revenueActions.status, ACTIVE_ACTION))),
    // prix de base : verrou structurant et plafond cumulé sur 7 jours (blueprint §6.4, §11.3)
    db.select({ type: revenueActions.type, status: revenueActions.status, approvedAt: revenueActions.approvedAt, createdAt: revenueActions.createdAt, parameters: revenueActions.parameters }).from(revenueActions)
      .where(and(eq(revenueActions.propertyId, p.id), eq(revenueActions.type, "BASE_PRICE_CHANGE"), inArray(revenueActions.status, [...STRUCTURAL_COUNTED_STATUSES]))),
    // annulations : historique des changements de réservation (borné à MAX_HISTORY_DAYS ; la borne UTC écarte au plus 2 h de marge sur le jour de Paris, sans effet car les fenêtres lues restent plus courtes)
    db.select({ externalId: reservationChanges.externalId, kind: reservationChanges.kind, before: reservationChanges.before, after: reservationChanges.after, createdAt: reservationChanges.createdAt }).from(reservationChanges)
      .where(and(eq(reservationChanges.propertyId, p.id), eq(reservationChanges.tenantId, tenantId), gte(reservationChanges.createdAt, new Date(addDays(today, -MAX_HISTORY_DAYS) + "T00:00:00Z")))).orderBy(reservationChanges.createdAt),
  ]);
  const [trk] = await db.select({ since: sql<Date | null>`min(${reservationChanges.createdAt})` }).from(reservationChanges).where(and(eq(reservationChanges.propertyId, p.id), eq(reservationChanges.tenantId, tenantId)));
  const cancellations: Cancellation[] = cancelledFromChanges(changes).filter(({ before }) => typeof before.channel === "string" && before.checkIn && before.checkOut && before.checkOut > before.checkIn && Number.isFinite(before.grossRoomCents)).map(({ before, at }) => ({ channel: before.channel, checkIn: before.checkIn, checkOut: before.checkOut, nights: diffDays(before.checkOut, before.checkIn), grossRoomCents: before.grossRoomCents, cancelledAt: at }));
  // PB-12 : depuis quand le retard de rythme est suivi = plus ancien dossier de rythme encore vivant (PB-01 : date de création ; PB-12 : `lagSince` qu'il porte,
  // car il remplace PB-01 sans effacer l'ancienneté). Aucun dossier vivant : inconnu, PB-12 reste silencieux.
  const lagRows = await db.select({ createdAt: opportunities.createdAt, signals: opportunities.signals, expiresAt: opportunities.expiresAt }).from(opportunities)
    .where(and(eq(opportunities.tenantId, tenantId), eq(opportunities.propertyId, p.id), inArray(opportunities.status, ["OPEN", "DEFERRED", "DECIDED", "EXPIRED"]),
      sql`(${opportunities.playbook} = 'PB-12' or (${opportunities.playbook} = 'PB-01' and ${opportunities.reasonCode} = 'PACE_BELOW_MARKET'))`));
  // un dossier compte tant que le retard est suivi : refraîchi (échéance dans le futur) ou interrompu depuis moins que la tolérance ; un dossier tranché
  // ou expiré depuis plus longtemps ne prolonge pas un retard résolu. L'ancienneté d'origine voyage dans `signals.lagSince` d'un dossier au suivant.
  const tolerance = addDays(today, -PLAYBOOKS["PB-12"].thresholds.lagGapToleranceDays.value);
  const lagSince = lagRows.filter((r) => r.expiresAt >= tolerance).map((r) => (typeof r.signals?.lagSince === "string" ? r.signals.lagSince : todayISO(r.createdAt))).sort()[0] ?? null;
  const firstBooking = resas.filter((r) => r.status === "CONFIRMED").map((r) => r.bookedAt).sort()[0] ?? null;
  const m = new Map(mkt.map((x) => [x.date, x]));
  const days: Day[] = cal.sort((a, b) => a.date.localeCompare(b.date)).map((c) => {
    // Blueprint §7.4 : un marché lu depuis plus de 48 h n'est plus une preuve. Il devient « inconnu » pour le moteur (aucune opportunité fondée dessus),
    // y compris quand la lecture suivante a échoué et que les jours précédents ont été conservés. Le logement de démonstration est simulé : exempté.
    const k0 = m.get(c.date), k = k0 && (p.isDemo || freshnessOf("MARKET", k0.observedAt, now).state === "FRESH") ? k0 : undefined;
    return { date: c.date, state: c.state as Day["state"], priceCents: c.priceCents, recommendedPriceCents: c.recommendedPriceCents, sentPriceCents: c.sentPriceCents, minStay: c.minStay, rule: c.rule, marketOccupancy: k?.marketOccupancy ?? null, marketAdrCents: k?.marketAdrCents ?? null, pricePercentile: k?.pricePercentile ?? null, event: k?.event ?? null };
  });
  // capacités de CE logement, déduites du catalogue du code (US-002) et non d'une ligne de base ; le coupe-circuit coupe les écritures du fournisseur
  const capabilities = capabilityFlags({ isDemo: p.isDemo, killSwitch: Object.fromEntries(ints.map((i) => [i.provider, i.killSwitch])) });
  // US-013 : un drapeau « écriture automatique » coupé retire la capacité d'écriture : la règle d'audit CAPABILITY n'en propose plus
  const flagRows = await loadFlags(tenantId);
  for (const id of Object.keys(capabilities)) {
    const def = capability(id);
    if (def?.kind === "write" && !resolveFlag("write.api", flagRows, { propertyId: p.id, provider: def.provider }).enabled) capabilities[id] = false;
  }
  return {
    today, now, property: { id: p.id, name: p.name, isDemo: p.isDemo }, model: p.economics as EconomicModel, strategy: p.strategy as Strategy, days,
    markups: p.isDemo ? undefined : channelMarkupsOf(p.channelMarkups),
    priceSource: p.pricelabs?.lastSync?.priceSource === "SUPERHOTE" ? "SUPERHOTE" : "PRICELABS",
    resas: resas.map((r) => ({ channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, grossRoomCents: r.grossRoomCents, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents, bookedAt: r.bookedAt, status: r.status }) satisfies Resa),
    promos: promos.map((x) => ({ id: x.id, channel: x.channel as Channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.stayFrom, stayTo: x.stayTo, verifiedAt: x.verifiedAt }) satisfies Promo),
    capabilities,
    lagSince, cancellations, cancellationTracking: trk?.since ? { since: todayISO(new Date(trk.since)) } : null, firstBookingDate: firstBooking,
    recentBaseChanges: recentBaseChanges(baseActs, today),
    structuralHold: structuralHold(baseActs),
    activeRanges: acts.filter((a) => a.type !== "MIN_PRICE_CHANGE").map((a) => { const ds: string[] | undefined = a.params?.dates; return ds?.length ? { from: ds[0], to: addDays(ds[ds.length - 1], 1) } : { from: a.from, to: a.to }; }),
  };
}

export function oppRow(o: DetectedOpportunity, scoring: ScoringConfig = DEFAULT_SCORING) {
  const c = o.candidates[o.selected];
  const score = scoreOpportunity(o, scoring);
  return {
    playbook: o.playbook, reasonCode: o.reasonCode, title: o.title, stayFrom: o.stayFrom, stayTo: o.stayTo,
    signals: { ...o.signals, marketAnalysis: deterministicAnalysis(o), agentOpinions: deterministicOpinions(o), independentReview: undefined as IndependentReview | undefined, signalText: o.signalText, signalSource: o.signalSource, hypothesisText: o.hypothesisText, vetoText: o.vetoText ?? null, signal: o.signal ?? null, score },
    diagnosis: o.diagnosis, candidates: o.candidates, selected: o.selected, priority: score.score, confidence: o.diagnosis.confidence,
    risk: c.risk, impactCents: c.type === "NO_ACTION" ? 0 : c.expectedDeltaCents, veto: o.veto, expiresAt: o.expiresAt,
  };
}
export const dedupeKey = (propertyId: string, o: DetectedOpportunity) => `${propertyId}|${o.playbook}|${o.dedupe ?? o.stayFrom}`;

async function nextCode(tenantId: string, today: ISODate): Promise<(i: number) => string> {
  const prefix = `S-${today.slice(2, 4)}${today.slice(5, 7)}-`;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(opportunities).where(and(eq(opportunities.tenantId, tenantId), sql`${opportunities.code} like ${prefix + "%"}`));
  return (i) => prefix + String(n + i + 1).padStart(2, "0");
}

type Step = { agent: string; label: string; detail: string; ok: boolean };

export type ReviewTrigger = "SCHEDULED" | "MANUAL" | "SIGNUP" | "EVENT";
export type ReviewOptions = {
  /** Limite la revue à ces logements (planificateur : chaque logement suit son propre rythme). Absent = tous les logements du compte. */
  propertyIds?: string[];
  /** Les données viennent d'être relues par le planificateur : ne pas relire avant la revue. */
  skipSync?: boolean;
};

/**
 * Revue (blueprint §6.3), de tous les logements du compte ou de ceux demandés. L'ordre des étapes est fixé ici : aucun agent n'en appelle un autre.
 * Chaque étape laisse une trace (AgentRun) ; la revue est idempotente grâce aux clés de dédoublonnage.
 * À la fin, le rythme de suivi de chaque logement revu est recalculé et sa prochaine revue planifiée.
 */
export async function runDailyReview(tenantId: string, trigger: ReviewTrigger = "SCHEDULED", opts: ReviewOptions = {}): Promise<{ opened: number; refreshed: number; expired: number; blocked: number; resting: number; reviewed: string[] }> {
  const now = new Date(), today = todayISO(now);
  const runId = newId("rev");
  await db.insert(reviewRuns).values({ id: runId, tenantId, kind: "DAILY", startedAt: now, stats: { trigger } });
  const steps: Step[] = [];
  const runs: (typeof agentRuns.$inferInsert)[] = [];
  const log = (agentId: string, operation: string, summary: string, extra: Partial<typeof agentRuns.$inferInsert> = {}) =>
    runs.push({ id: newId("run"), tenantId, agentId, operation, mode: "DETERMINISTIC", summary, createdAt: new Date(), ...extra });

  // priorités réglables par espace (Réglages) ; une valeur absente ou hors bornes retombe sur le réglage par défaut
  const [tenantRow] = await db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, tenantId));
  const scoring = resolveScoring(tenantRow?.settings?.scoring);
  const all = await db.select().from(properties).where(eq(properties.tenantId, tenantId));
  const props = opts.propertyIds ? all.filter((p) => opts.propertyIds!.includes(p.id)) : all;
  const blockedIds = new Set<string>();
  const code = await nextCode(tenantId, today);
  // budget des appels de modèle de la revue (US-074) ; les cibles de la passerelle sont résolues une fois par agent
  const budget = await openBudget(tenantId, now);
  const llm = await resolveTargets(tenantId, "direction");
  budget.targets.set("direction", llm);
  const llmMarche = (await resolveTargets(tenantId, "marche")).length > 0;
  const llmAudit = (await resolveTargets(tenantId, "audit")).length > 0;
  const llmStrategist: Record<StrategistId, boolean> = { pricing: (await resolveTargets(tenantId, "pricing")).length > 0, distribution: (await resolveTargets(tenantId, "distribution")).length > 0 };
  let opened = 0, refreshed = 0, expired = 0, blocked = 0, resting = 0, seq = 0;
  const counts = { options: 0, approve: 0, reject: 0, human: 0, pricing: 0, distribution: 0, annonce: 0 };

  // les dossiers différés redeviennent ouverts à leur échéance
  await db.update(opportunities).set({ status: "OPEN", deferUntil: null }).where(and(eq(opportunities.tenantId, tenantId), eq(opportunities.status, "DEFERRED"), lte(opportunities.deferUntil, today)));

  for (const p of props) {
    if (p.isDemo) await db.update(calendarDays).set({ observedAt: now }).where(eq(calendarDays.propertyId, p.id));
    if (!opts.skipSync) await syncIfStale(tenantId, p);
    const input = await loadEngineInput(tenantId, p.id, today, now);
    if (!input) continue;
    if (input.days.length === 0) {
      blocked++; blockedIds.add(p.id); log("onboarding", "reconcile", `${p.name} : aucun calendrier à lire. PriceLabs n'est pas encore connecté à ce logement ; aucune revue possible.`);
      continue;
    }
    const unknownPrice = input.days.filter((d) => d.priceCents === null).length;
    log("onboarding", "reconcile", `${p.name} : ${input.days.length} jours de calendrier et ${input.resas.length} réservations rapprochés${unknownPrice ? ` · ${unknownPrice} prix inconnus` : ""}${p.isDemo ? " · données de démonstration" : ""}.`);
    const res = reviewProperty(input);
    if (res.blocked.length) {
      blocked++; blockedIds.add(p.id); log("onboarding", "quality", `${p.name} : modèle économique incomplet (${res.blocked.join(", ")}). Aucune opportunité financière n'est ouverte tant que ces valeurs sont inconnues.`);
      continue;
    }
    if (res.conformity.length) log("audit", "conformity", `${p.name} : ${res.conformity.length} option${res.conformity.length > 1 ? "s" : ""} retirée${res.conformity.length > 1 ? "s" : ""} faute de respecter le contrat de son type d'action (${res.conformity.map((c) => c.candidate + " : " + c.issues.join(", ")).join(" ; ").slice(0, 400)}).`, { error: "CANDIDATE_CONFORMITY" });
    if (res.missingMarkups.length) log("onboarding", "quality", `${p.name} : majoration ${res.missingMarkups.map((c) => (c === "AIRBNB" ? "Airbnb" : "Booking.com")).join(" et ")} non renseignée : ce canal est exclu de la revue (aucun prix vendu n'est calculé sans majoration). Saisissez-la dans les réglages du logement.`);
    const gaps = res.stats.filter((s) => s.gap !== null).map((s) => `${s.label} ${s.gap! >= 0 ? "+" : "−"}${Math.abs(Math.round(s.gap! * 100))} pts`).join(" · ");
    log("marche", "analyzeMarket", `${p.name} : écart d'occupation au marché — ${gaps || "données de marché inconnues"}.`, { output: res.stats.map(({ freeDates, ...s }) => s) });

    const existing = await db.select().from(opportunities).where(and(eq(opportunities.propertyId, p.id), inArray(opportunities.status, ["OPEN", "DEFERRED", "DECIDED"])));
    const seen = new Set<string>();
    // un même signal ne produit qu'un dossier par revue (le plus prioritaire), puis les dossiers qui se touchent sont regroupés
    const found = dedupeOpportunities(res.opportunities, (x) => scoreOpportunity(x, scoring).score);
    // la clé suit les dossiers détectés (y compris ceux laissés au repos) : elle peut changer d'une revue à l'autre, seuls les dossiers ouverts sont listés ensemble
    const groups = groupKeys(found, p.id);
    for (const [idx, o] of found.entries()) {
      const key = dedupeKey(p.id, o); seen.add(key);
      const prev = existing.filter((e) => e.dedupeKey === key).sort((a, b) => +b.createdAt - +a.createdAt)[0];
      for (const c of o.candidates) {
        counts.options++; counts[c.audit.verdict === "APPROVE" ? "approve" : c.audit.verdict === "REJECT" ? "reject" : "human"]++;
        if (c.agent === "pricing" || c.agent === "distribution" || c.agent === "annonce") counts[c.agent]++;
      }
      const decision = openingDecision(prev, o.playbook, now);
      if (decision.action === "SKIP") { resting++; continue; } // période de repos du playbook, ou dossier différé
      // groupe de repos (PB-02, PB-11, PB-12 : même levier) : une décision sur l'un met les autres au repos, sauf pour un dossier déjà ouvert que l'on rafraîchit
      if (decision.action === "CREATE" && groupCooldownUntil(existing.map((e) => ({ ...e, selectedType: (e.candidates as { type: string }[] | null)?.[e.selected]?.type ?? null })), o.playbook, now)) { resting++; continue; }
      const row = { ...oppRow(o, scoring), groupKey: groups[idx] };
      // US-071 : constats de l'analyste marché. Une analyse par modèle n'est refaite que si les faits ont changé (la revue est fréquente, le budget est borné).
      const prevAnalysis = prev?.signals?.marketAnalysis as MarketAnalysis | undefined;
      // Même logique après un échec du modèle (sortie invalide, panne) : pas de nouvel essai pour les mêmes faits avant 6 h.
      const sameFacts = !!prevAnalysis && prevAnalysis.evidenceHash === evidenceHashOf(o, PROMPTS["marche.market_analysis"].version);
      const reuse = sameFacts && (prevAnalysis!.mode === "LLM" || (!!prevAnalysis!.triedAt && +now - +new Date(prevAnalysis!.triedAt) < 6 * 3600_000));
      const analysisFor = async (oppId: string) => {
        if (reuse) return prevAnalysis!;
        if (!llmMarche) return deterministicAnalysis(o);
        const a = await analyzeMarket(budget, o, oppId);
        await db.insert(agentRuns).values(a.outcome.run);
        return a.analysis;
      };
      // US-072 : avis des stratèges sur leurs options (mêmes règles de réutilisation que l'analyse : faits et prompt inchangés, ou échec récent).
      const opinionsFor = async (oppId: string) => {
        const out: Partial<Record<StrategistId, AgentOpinion>> = {};
        for (const agent of ["pricing", "distribution"] as const) {
          if (ownedOptions(o, agent).length === 0) continue;
          const old = (prev?.signals?.agentOpinions as Partial<Record<StrategistId, AgentOpinion>> | undefined)?.[agent];
          const same = !!old && old.factsHash === factsHashOf(o, agent, opinionPromptVersion(agent)) && old.items.every((i) => o.candidates[i.candidate]?.agent === agent);
          if (same && (old!.mode === "LLM" || (!!old!.triedAt && +now - +new Date(old!.triedAt) < 6 * 3600_000))) { out[agent] = old!; continue; }
          if (!llmStrategist[agent]) { out[agent] = deterministicOpinion(o, agent); continue; }
          const r = await opine(budget, o, agent, oppId);
          await db.insert(agentRuns).values(r.outcome.run);
          out[agent] = r.opinion;
        }
        return out;
      };
      // US-073 : seconde lecture indépendante de l'option retenue. Elle ne peut qu'ajouter une alerte (validation humaine) ; la réserve est ré-appliquée à chaque rafraîchissement.
      const secondReadingFor = async (oppId: string) => {
        if (!reviewable(o)) return;
        const old = prev?.signals?.independentReview as IndependentReview | undefined;
        const same = !!old && old.factsHash === reviewHashOf(o, reviewPromptVersion());
        let rev: IndependentReview | undefined;
        if (same && (old!.mode === "LLM" || (!!old!.triedAt && +now - +new Date(old!.triedAt) < 6 * 3600_000))) rev = old;
        else if (llmAudit) { const r = await secondReading(budget, o, oppId); await db.insert(agentRuns).values(r.outcome.run); rev = r.review; }
        if (!rev) return;
        row.signals = { ...row.signals, independentReview: rev };
        row.candidates = applyReview(row.candidates, o.selected, rev);
      };
      if (decision.action === "REFRESH" && prev) {
        row.signals = { ...row.signals, marketAnalysis: await analysisFor(prev.id), agentOpinions: await opinionsFor(prev.id) };
        await secondReadingFor(prev.id);
        const sameChoice = prev.candidates?.[prev.selected]?.label === o.candidates[o.selected].label;
        await db.update(opportunities).set({ ...row, narrative: sameChoice && prev.narrative ? prev.narrative : deterministicNarrative(o) }).where(eq(opportunities.id, prev.id));
        refreshed++; continue;
      }
      let narrative = deterministicNarrative(o);
      const id = newId("opp");
      if (llm.length) {
        const w = await writeNarrative(budget, o, p.name, id); narrative = w.narrative;
        // trace enregistrée tout de suite : le budget du jour la voit, même si la revue échoue plus loin ou si une autre revue tourne en parallèle
        await db.insert(agentRuns).values(w.outcome.run);
      }
      // la synthèse adressée au propriétaire passe avant l'analyse : quand le plafond est serré, c'est elle qui est servie
      row.signals = { ...row.signals, marketAnalysis: await analysisFor(id), agentOpinions: await opinionsFor(id) };
      await secondReadingFor(id);
      await db.insert(opportunities).values({ id, tenantId, propertyId: p.id, code: code(seq++), dedupeKey: key, ...row, narrative, status: "OPEN", createdAt: now });
      opened++;
    }
    for (const e of existing) if (e.status === "OPEN" && (!seen.has(e.dedupeKey) || e.expiresAt < today)) {
      await db.update(opportunities).set({ status: "EXPIRED" }).where(eq(opportunities.id, e.id)); expired++;
    }
  }

  const measured = await measureDueActions(tenantId, today);
  log("direction", "prioritize", `Revue terminée : ${opened} dossier${opened > 1 ? "s" : ""} ouvert${opened > 1 ? "s" : ""}, ${refreshed} mis à jour, ${expired} expiré${expired > 1 ? "s" : ""}${resting ? `, ${resting} en période de repos ou différé${resting > 1 ? "s" : ""}` : ""}${blocked ? `, ${blocked} logement${blocked > 1 ? "s" : ""} bloqué${blocked > 1 ? "s" : ""} faute de données` : ""}.`);
  if (counts.pricing) log("pricing", "proposeStrategy", `${counts.pricing} option${counts.pricing > 1 ? "s" : ""} tarifaire${counts.pricing > 1 ? "s" : ""} instruite${counts.pricing > 1 ? "s" : ""} et simulée${counts.pricing > 1 ? "s" : ""} en revenu net.`);
  if (counts.distribution) log("distribution", "compilePromotion", `${counts.distribution} option${counts.distribution > 1 ? "s" : ""} de distribution instruite${counts.distribution > 1 ? "s" : ""}, cumul des remises contrôlé sur chaque canal.`);
  if (counts.annonce) log("annonce", "auditListing", `${counts.annonce} audit${counts.annonce > 1 ? "s" : ""} d'annonce proposé${counts.annonce > 1 ? "s" : ""} avant toute remise.`);
  if (counts.options) log("audit", "audit", `${counts.options} options auditées : ${counts.approve} conformes, ${counts.human} à valider avec commentaire, ${counts.reject} rejetée${counts.reject > 1 ? "s" : ""}.`);
  log("reporting", "measure", measured ? `${measured} action${measured > 1 ? "s" : ""} mesurée${measured > 1 ? "s" : ""} à l'échéance de sa fenêtre d'observation.` : "Aucune mesure à échéance aujourd'hui.");
  if (runs.length) await db.insert(agentRuns).values(runs);
  steps.push(...runs.map((r) => ({ agent: r.agentId, label: r.operation, detail: r.summary, ok: !r.error })));
  const scope = opts.propertyIds ? props.map((p) => p.name).join(", ") : null;
  await db.update(reviewRuns).set({ finishedAt: new Date(), steps, stats: { trigger, opened, refreshed, expired, blocked, resting, properties: props.length, propertyIds: opts.propertyIds ?? null, scope, llm: llm.length > 0 } }).where(eq(reviewRuns.id, runId));
  // les revues planifiées sont fréquentes (jusqu'à quatre par jour et par logement) : seules celles qui changent quelque chose entrent au journal
  if (!(trigger === "SCHEDULED" && opened === 0 && expired === 0)) {
    const how = trigger === "MANUAL" ? "lancée à la main" : trigger === "SIGNUP" ? "première revue" : trigger === "EVENT" ? "après un changement de réservation" : "planifiée";
    await recordAudit(db, { tenantId, actor: "agent:direction", type: "review.completed", entity: "ReviewRun", entityId: runId, summary: `Revue ${scope ? "de " + scope : "de tous les logements"} (${how}) : ${opened} ouverts, ${expired} expirés.`, payload: { trigger, opened, refreshed, expired, blocked } });
  }
  // rythme de suivi : recalculé après chaque revue, qui fixe aussi l'échéance de la suivante
  const { refreshCadence } = await import("./cadence");
  for (const p of props) {
    try { await refreshCadence(tenantId, p.id, { reviewed: { blocked: blockedIds.has(p.id) } }, now); } catch (e) { console.error("[rythme]", p.id, e); }
  }
  return { opened, refreshed, expired, blocked, resting, reviewed: props.map((p) => p.id) };
}
