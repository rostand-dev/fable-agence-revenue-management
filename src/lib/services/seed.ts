import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { addDays, todayISO } from "../dates";
import { buildDemo } from "../engine/demo";
import { reviewProperty } from "../engine/detect";
import type { DetectedOpportunity } from "../engine/types";
import { deterministicNarrative } from "./narrative";
import { dedupeKey, oppRow, runDailyReview } from "./review";

const s = schema;
const DEFAULT_CAPS = {
  pricelabs: { "pricelabs.read": true, "pricelabs.write": true },
  superhote: { "superhote.webhooks": true, "superhote.reconcile": true },
  booking: { "booking.promotions.read": false, "booking.promotions.write": false },
  airbnb: { "airbnb.promotions.read": false, "airbnb.promotions.write": false },
};

/** Installe (ou réinstalle) les deux logements de démonstration d'un propriétaire, ancrés à aujourd'hui. */
export async function seedDemo(tenantId: string): Promise<void> {
  const now = new Date(), today = todayISO(now);
  const old = await db.select({ id: s.properties.id }).from(s.properties).where(and(eq(s.properties.tenantId, tenantId), eq(s.properties.isDemo, true)));
  for (const p of old) await db.delete(s.properties).where(eq(s.properties.id, p.id));
  const [t] = await db.select().from(s.tenants).where(eq(s.tenants.id, tenantId));
  await db.update(s.tenants).set({ settings: { ...(t?.settings ?? {}), demoAnchor: today } }).where(eq(s.tenants.id, tenantId));

  for (const [provider, caps] of Object.entries(DEFAULT_CAPS)) {
    await db.insert(s.integrations).values({
      id: newId("int"), tenantId, provider, capabilities: caps, lastSyncAt: provider === "pricelabs" || provider === "superhote" ? now : null,
      status: provider === "pricelabs" || provider === "superhote" ? "DEMO" : "NOT_CONNECTED",
      note: provider === "pricelabs" || provider === "superhote" ? "Source simulée pour les logements de démonstration." : "Accès partenaire officiel non obtenu : promotions gérées par procédure manuelle guidée.",
    }).onConflictDoNothing();
  }

  const past = addDays(today, -38), pastNow = new Date(+now - 38 * 86400000);
  const demo = buildDemo(today), demoPast = buildDemo(past);
  const ids: Record<string, string> = {};
  for (const p of demo) {
    const id = newId("prop"); ids[p.key] = id;
    await db.insert(s.properties).values({ id, tenantId, name: p.name, city: p.city, kind: p.kind, bedrooms: p.bedrooms, capacity: p.capacity, status: "ACTIVE", isDemo: true, profile: p.profile, economics: p.economics, strategy: p.strategy });
    await db.insert(s.reservations).values(p.reservations.map((r) => ({ id: newId("res"), tenantId, propertyId: id, ...r, source: "DEMO" })));
    await db.insert(s.calendarDays).values(p.days.map((d) => ({ propertyId: id, tenantId, date: d.date, priceCents: d.priceCents, minStay: d.minStay, state: d.state, rule: d.rule, observedAt: now })));
    await db.insert(s.marketDays).values(p.days.map((d) => ({ propertyId: id, tenantId, date: d.date, marketOccupancy: d.marketOccupancy, marketAdrCents: d.marketAdrCents, pricePercentile: d.pricePercentile, event: d.event, observedAt: now })));
    await db.insert(s.promotions).values(p.promos.map((x) => ({ id: newId("promo"), tenantId, propertyId: id, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.fromOffset === null ? null : addDays(today, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(today, x.toOffset), status: "ACTIVE", source: "DEMO", verifiedAt: new Date(+now - x.verifiedDaysAgo * 86400000) })));
  }

  // Historique de démonstration : quatre dossiers déjà traités, produits par le même moteur un mois plus tôt.
  const hist: { key: string; pick: (o: DetectedOpportunity) => boolean; candidate: string; outcome: "POSITIVE" | "NEUTRAL" | "INCONCLUSIVE" | null; observed?: string; interpretation?: string; comment?: string }[] = [
    { key: "chatillon", pick: (o) => o.playbook === "PB-03", candidate: "MIN_STAY_OVERRIDE", outcome: "POSITIVE", observed: "Les 2 nuits du trou ont été réservées 4 jours après l'action, au prix publié.", interpretation: "Les nuits étaient invendables avant l'action : le lien est plausible. Sans période témoin, il reste une corrélation." },
    { key: "evry", pick: (o) => o.playbook === "PB-07", candidate: "PRICE_OVERRIDE", outcome: "INCONCLUSIVE", observed: "1 nuit sur 3 réservée au prix relevé à la fin de la fenêtre d'observation.", interpretation: "Trop peu de nuits pour conclure ; l'événement lui-même a pu suffire à remplir.", comment: "Événement confirmé par le site de l'organisateur." },
    { key: "chatillon", pick: (o) => o.playbook === "PB-05", candidate: "PROMO_REMOVAL", outcome: "NEUTRAL", observed: "Aucune nuit supplémentaire vendue sur la période pendant la fenêtre d'observation.", interpretation: "Le retrait de la remise n'a ni accéléré ni freiné les réservations mesurées ; le prix vendu est repassé au-dessus du plancher stratégique." },
    { key: "chatillon", pick: (o) => o.playbook === "PB-01" && o.diagnosis.primary === "BOOKING_WINDOW_NOT_OPEN", candidate: "NO_ACTION", outcome: null },
  ];
  let n = 0;
  for (const h of hist) {
    const p = demoPast.find((x) => x.key === h.key)!;
    const res = reviewProperty({
      today: past, now: pastNow, property: { id: ids[h.key], name: p.name, isDemo: true }, model: p.economics, strategy: p.strategy, days: p.days,
      resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })), capabilities: DEFAULT_CAPS.pricelabs, activeRanges: [],
      promos: p.promos.map((x, i) => ({ id: "h" + i, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct, stayFrom: x.fromOffset === null ? null : addDays(past, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(past, x.toOffset), verifiedAt: new Date(+pastNow - x.verifiedDaysAgo * 86400000) })),
    });
    const o = res.opportunities.find(h.pick);
    if (!o) continue;
    const ci = Math.max(0, o.candidates.findIndex((c) => c.type === h.candidate && c.audit.verdict !== "REJECT"));
    const c = o.candidates[ci]; o.selected = ci;
    const oppId = newId("opp"), created = new Date(+pastNow + n * 3600000);
    await db.insert(s.opportunities).values({
      id: oppId, tenantId, propertyId: ids[h.key], code: `S-${past.slice(2, 4)}${past.slice(5, 7)}-${String(++n).padStart(2, "0")}`, dedupeKey: "demo-hist|" + dedupeKey(ids[h.key], o),
      ...oppRow(o), narrative: deterministicNarrative(o), status: "DECIDED", decision: c.type === "NO_ACTION" ? "NO_ACTION" : "APPROVED", createdAt: created,
    });
    if (c.type === "NO_ACTION") {
      await db.insert(s.auditEvents).values({ id: newId("evt"), tenantId, actor: "demo", type: "opportunity.no_action", entity: "Opportunity", entityId: oppId, summary: `Inaction retenue sur le dossier (historique de démonstration).`, createdAt: created });
      continue;
    }
    const approvedAt = new Date(+created + 2 * 3600000), executedAt = new Date(+approvedAt + 3600000), measuredAt = new Date(+executedAt + (c.measurementWindowDays || 7) * 86400000);
    const actId = newId("act");
    await db.insert(s.revenueActions).values({
      id: actId, tenantId, propertyId: ids[h.key], opportunityId: oppId, type: c.type, label: c.label, target: c.target, parameters: c.parameters,
      simulation: { current: c.current, proposed: c.proposed, expectedDeltaCents: c.expectedDeltaCents, hypothesis: c.hypothesis, executionMode: c.executionMode, measurementWindowDays: c.measurementWindowDays },
      audit: c.audit, status: "CLOSED", riskLevel: c.risk, rollbackPlan: c.rollbackPlan, idempotencyKey: `${oppId}:${ci}`, approvalComment: h.comment ?? null, approvedAt, executedAt, verifiedAt: executedAt,
      execution: { mode: c.executionMode === "MANUAL_RUNBOOK" ? "MANUAL_DECLARED" : "DEMO_SIMULATED", note: "Historique de démonstration.", declaredScope: c.executionMode === "MANUAL_RUNBOOK" ? "Promotion retirée sur les dates du dossier" : undefined, declaredDate: executedAt.toISOString().slice(0, 10), verification: { mode: "READ_BACK", note: "État relu conforme à l'action approuvée." } },
      measureDueAt: measuredAt.toISOString().slice(0, 10),
      measurement: { outcome: h.outcome, observed: h.observed, interpretation: h.interpretation, incrementalCents: null, confidence: "faible", measuredAt: measuredAt.toISOString() },
      createdAt: created, updatedAt: measuredAt,
    });
    await db.insert(s.auditEvents).values([
      { id: newId("evt"), tenantId, actor: "demo", type: "action.approved", entity: "RevenueAction", entityId: actId, summary: `« ${c.label} » approuvée (historique de démonstration).`, createdAt: approvedAt },
      { id: newId("evt"), tenantId, actor: "demo", type: "action.executed", entity: "RevenueAction", entityId: actId, summary: `« ${c.label} » exécutée puis vérifiée (historique de démonstration).`, createdAt: executedAt },
      { id: newId("evt"), tenantId, actor: "agent:reporting", type: "experiment.measured", entity: "RevenueAction", entityId: actId, summary: `Mesure de « ${c.label} » : ${h.outcome === "POSITIVE" ? "positif (corrélation)" : h.outcome === "NEUTRAL" ? "neutre" : "non concluant"}.`, createdAt: measuredAt },
    ]);
  }
  await db.insert(s.auditEvents).values({ id: newId("evt"), tenantId, actor: "system", type: "demo.seeded", entity: "Tenant", entityId: tenantId, summary: `Logements de démonstration installés, ancrés au ${today.split("-").reverse().join("/")}.` });
  await runDailyReview(tenantId, "SIGNUP");
}
