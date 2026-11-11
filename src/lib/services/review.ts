import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { addDays, todayISO, type ISODate } from "../dates";
import { priorityScore, reviewProperty, type EngineInput } from "../engine/detect";
import type { Channel, Day, DetectedOpportunity, EconomicModel, Promo, Resa, Strategy } from "../engine/types";
import { llmEnabled } from "../agents/llm";
import { deterministicNarrative, writeNarrative } from "./narrative";
import { measureDueActions } from "./decisions";

const { properties, calendarDays, marketDays, reservations, promotions, opportunities, revenueActions, agentRuns, auditEvents, integrations, reviewRuns } = schema;
const ACTIVE_ACTION = ["APPROVED", "EXECUTING", "EXECUTED", "VERIFIED", "MEASURING"];

export async function loadEngineInput(tenantId: string, propertyId: string, today: ISODate, now = new Date()): Promise<EngineInput | null> {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) return null;
  const to = addDays(today, 90);
  const [cal, mkt, resas, promos, ints, acts] = await Promise.all([
    db.select().from(calendarDays).where(and(eq(calendarDays.propertyId, p.id), gte(calendarDays.date, today), lte(calendarDays.date, to))),
    db.select().from(marketDays).where(and(eq(marketDays.propertyId, p.id), gte(marketDays.date, today), lte(marketDays.date, to))),
    db.select().from(reservations).where(eq(reservations.propertyId, p.id)),
    db.select().from(promotions).where(and(eq(promotions.propertyId, p.id), eq(promotions.status, "ACTIVE"))),
    db.select().from(integrations).where(eq(integrations.tenantId, tenantId)),
    db.select({ from: opportunities.stayFrom, to: opportunities.stayTo, params: revenueActions.parameters }).from(revenueActions)
      .innerJoin(opportunities, eq(opportunities.id, revenueActions.opportunityId))
      .where(and(eq(revenueActions.propertyId, p.id), inArray(revenueActions.status, ACTIVE_ACTION))),
  ]);
  const m = new Map(mkt.map((x) => [x.date, x]));
  const days: Day[] = cal.sort((a, b) => a.date.localeCompare(b.date)).map((c) => {
    const k = m.get(c.date);
    return { date: c.date, state: c.state as Day["state"], priceCents: c.priceCents, minStay: c.minStay, rule: c.rule, marketOccupancy: k?.marketOccupancy ?? null, marketAdrCents: k?.marketAdrCents ?? null, pricePercentile: k?.pricePercentile ?? null, event: k?.event ?? null };
  });
  const capabilities: Record<string, boolean> = {};
  for (const i of ints) if (!i.killSwitch) Object.assign(capabilities, i.capabilities);
  return {
    today, now, property: { id: p.id, name: p.name, isDemo: p.isDemo }, model: p.economics as EconomicModel, strategy: p.strategy as Strategy, days,
    resas: resas.map((r) => ({ channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, grossRoomCents: r.grossRoomCents, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents, bookedAt: r.bookedAt, status: r.status }) satisfies Resa),
    promos: promos.map((x) => ({ id: x.id, channel: x.channel as Channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.stayFrom, stayTo: x.stayTo, verifiedAt: x.verifiedAt }) satisfies Promo),
    capabilities,
    activeRanges: acts.map((a) => { const ds: string[] | undefined = a.params?.dates; return ds?.length ? { from: ds[0], to: addDays(ds[ds.length - 1], 1) } : { from: a.from, to: a.to }; }),
  };
}

export function oppRow(o: DetectedOpportunity) {
  const c = o.candidates[o.selected];
  return {
    playbook: o.playbook, reasonCode: o.reasonCode, title: o.title, stayFrom: o.stayFrom, stayTo: o.stayTo,
    signals: { ...o.signals, signalText: o.signalText, signalSource: o.signalSource, hypothesisText: o.hypothesisText, vetoText: o.vetoText ?? null },
    diagnosis: o.diagnosis, candidates: o.candidates, selected: o.selected, priority: priorityScore(o), confidence: o.diagnosis.confidence,
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

/**
 * Revue quotidienne (blueprint §6.3). L'ordre des étapes est fixé ici : aucun agent n'en appelle un autre.
 * Chaque étape laisse une trace (AgentRun) ; la revue est idempotente grâce aux clés de dédoublonnage.
 */
export async function runDailyReview(tenantId: string, trigger: "SCHEDULED" | "MANUAL" | "SIGNUP" = "SCHEDULED"): Promise<{ opened: number; refreshed: number; expired: number; blocked: number }> {
  const now = new Date(), today = todayISO(now);
  const runId = newId("rev");
  await db.insert(reviewRuns).values({ id: runId, tenantId, kind: "DAILY", startedAt: now, stats: { trigger } });
  const steps: Step[] = [];
  const runs: (typeof agentRuns.$inferInsert)[] = [];
  const log = (agentId: string, operation: string, summary: string, extra: Partial<typeof agentRuns.$inferInsert> = {}) =>
    runs.push({ id: newId("run"), tenantId, agentId, operation, mode: "DETERMINISTIC", summary, createdAt: new Date(), ...extra });

  const props = await db.select().from(properties).where(eq(properties.tenantId, tenantId));
  const code = await nextCode(tenantId, today);
  let opened = 0, refreshed = 0, expired = 0, blocked = 0, seq = 0, llmBudget = 10;
  const counts = { options: 0, approve: 0, reject: 0, human: 0, pricing: 0, distribution: 0, annonce: 0 };

  // les dossiers différés redeviennent ouverts à leur échéance
  await db.update(opportunities).set({ status: "OPEN", deferUntil: null }).where(and(eq(opportunities.tenantId, tenantId), eq(opportunities.status, "DEFERRED"), lte(opportunities.deferUntil, today)));

  for (const p of props) {
    if (p.isDemo) await db.update(calendarDays).set({ observedAt: now }).where(eq(calendarDays.propertyId, p.id));
    const input = await loadEngineInput(tenantId, p.id, today, now);
    if (!input) continue;
    if (input.days.length === 0) {
      blocked++; log("onboarding", "reconcile", `${p.name} : aucun calendrier à lire. Les intégrations ne sont pas encore connectées ; aucune revue possible.`);
      continue;
    }
    const unknownPrice = input.days.filter((d) => d.priceCents === null).length;
    log("onboarding", "reconcile", `${p.name} : ${input.days.length} jours de calendrier et ${input.resas.length} réservations rapprochés${unknownPrice ? ` · ${unknownPrice} prix inconnus` : ""}${p.isDemo ? " · données de démonstration" : ""}.`);
    const res = reviewProperty(input);
    if (res.blocked.length) {
      blocked++; log("onboarding", "quality", `${p.name} : modèle économique incomplet (${res.blocked.join(", ")}). Aucune opportunité financière n'est ouverte tant que ces valeurs sont inconnues.`);
      continue;
    }
    const gaps = res.stats.filter((s) => s.gap !== null).map((s) => `${s.label} ${s.gap! >= 0 ? "+" : "−"}${Math.abs(Math.round(s.gap! * 100))} pts`).join(" · ");
    log("marche", "analyzeMarket", `${p.name} : écart d'occupation au marché — ${gaps || "données de marché inconnues"}.`, { output: res.stats.map(({ freeDates, ...s }) => s) });

    const existing = await db.select().from(opportunities).where(and(eq(opportunities.propertyId, p.id), inArray(opportunities.status, ["OPEN", "DEFERRED", "DECIDED"])));
    const seen = new Set<string>();
    for (const o of res.opportunities) {
      const key = dedupeKey(p.id, o); seen.add(key);
      const prev = existing.filter((e) => e.dedupeKey === key).sort((a, b) => +b.createdAt - +a.createdAt)[0];
      for (const c of o.candidates) {
        counts.options++; counts[c.audit.verdict === "APPROVE" ? "approve" : c.audit.verdict === "REJECT" ? "reject" : "human"]++;
        if (c.agent === "pricing" || c.agent === "distribution" || c.agent === "annonce") counts[c.agent]++;
      }
      if (prev && prev.status === "DECIDED" && +now - +prev.createdAt < 21 * 86400000) continue; // cooldown du playbook
      if (prev && prev.status === "DEFERRED") continue;
      const row = oppRow(o);
      if (prev && prev.status === "OPEN") {
        const sameChoice = prev.candidates?.[prev.selected]?.label === o.candidates[o.selected].label;
        await db.update(opportunities).set({ ...row, narrative: sameChoice && prev.narrative ? prev.narrative : deterministicNarrative(o) }).where(eq(opportunities.id, prev.id));
        refreshed++; continue;
      }
      let narrative = deterministicNarrative(o);
      const id = newId("opp");
      if (llmEnabled() && llmBudget-- > 0) {
        const w = await writeNarrative(o, p.name); narrative = w.narrative;
        log("direction", "explainAction", `Synthèse du dossier « ${o.title} » ${w.error ? "rédigée en repli déterministe (" + w.error + ")" : "rédigée"}.`, { mode: narrative.mode, model: narrative.model, promptVersion: narrative.promptVersion, opportunityId: id, inputTokens: w.usage?.inputTokens, outputTokens: w.usage?.outputTokens, durationMs: w.usage?.durationMs ?? 0, error: w.error });
      }
      await db.insert(opportunities).values({ id, tenantId, propertyId: p.id, code: code(seq++), dedupeKey: key, ...row, narrative, status: "OPEN", createdAt: now });
      opened++;
    }
    for (const e of existing) if (e.status === "OPEN" && (!seen.has(e.dedupeKey) || e.expiresAt < today)) {
      await db.update(opportunities).set({ status: "EXPIRED" }).where(eq(opportunities.id, e.id)); expired++;
    }
  }

  const measured = await measureDueActions(tenantId, today);
  log("direction", "prioritize", `Revue terminée : ${opened} dossier${opened > 1 ? "s" : ""} ouvert${opened > 1 ? "s" : ""}, ${refreshed} mis à jour, ${expired} expiré${expired > 1 ? "s" : ""}${blocked ? `, ${blocked} logement${blocked > 1 ? "s" : ""} bloqué${blocked > 1 ? "s" : ""} faute de données` : ""}.`);
  if (counts.pricing) log("pricing", "proposeStrategy", `${counts.pricing} option${counts.pricing > 1 ? "s" : ""} tarifaire${counts.pricing > 1 ? "s" : ""} instruite${counts.pricing > 1 ? "s" : ""} et simulée${counts.pricing > 1 ? "s" : ""} en revenu net.`);
  if (counts.distribution) log("distribution", "compilePromotion", `${counts.distribution} option${counts.distribution > 1 ? "s" : ""} de distribution instruite${counts.distribution > 1 ? "s" : ""}, cumul des remises contrôlé sur chaque canal.`);
  if (counts.annonce) log("annonce", "auditListing", `${counts.annonce} audit${counts.annonce > 1 ? "s" : ""} d'annonce proposé${counts.annonce > 1 ? "s" : ""} avant toute remise.`);
  if (counts.options) log("audit", "audit", `${counts.options} options auditées : ${counts.approve} conformes, ${counts.human} à valider avec commentaire, ${counts.reject} rejetée${counts.reject > 1 ? "s" : ""}.`);
  log("reporting", "measure", measured ? `${measured} action${measured > 1 ? "s" : ""} mesurée${measured > 1 ? "s" : ""} à l'échéance de sa fenêtre d'observation.` : "Aucune mesure à échéance aujourd'hui.");
  if (runs.length) await db.insert(agentRuns).values(runs);
  steps.push(...runs.map((r) => ({ agent: r.agentId, label: r.operation, detail: r.summary, ok: !r.error })));
  await db.update(reviewRuns).set({ finishedAt: new Date(), steps, stats: { trigger, opened, refreshed, expired, blocked, properties: props.length, llm: llmEnabled() } }).where(eq(reviewRuns.id, runId));
  await db.insert(auditEvents).values({ id: newId("evt"), tenantId, actor: "agent:direction", type: "review.completed", entity: "ReviewRun", entityId: runId, summary: `Revue quotidienne (${trigger === "MANUAL" ? "lancée à la main" : trigger === "SIGNUP" ? "première revue" : "planifiée"}) : ${opened} ouverts, ${expired} expirés.` });
  return { opened, refreshed, expired, blocked };
}

/** Planification interne : une revue par propriétaire et par jour, déclenchée au premier passage après 06:00 (Paris). */
export async function runDueReviews(): Promise<number> {
  const now = new Date(), today = todayISO(now);
  const hour = Number(new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", hour12: false, timeZone: "Europe/Paris" }).format(now).slice(0, 2));
  if (hour < 6) return 0;
  const ts = await db.select({ id: schema.tenants.id }).from(schema.tenants);
  let n = 0;
  for (const t of ts) {
    const [last] = await db.select({ at: reviewRuns.startedAt }).from(reviewRuns).where(eq(reviewRuns.tenantId, t.id)).orderBy(sql`${reviewRuns.startedAt} desc`).limit(1);
    if (last && todayISO(last.at) === today) continue;
    try { await runDailyReview(t.id, "SCHEDULED"); n++; } catch (e) { console.error("[revue]", t.id, e); }
  }
  return n;
}
