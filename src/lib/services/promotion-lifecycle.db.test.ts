import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { emptyEconomics } from "@/lib/engine/economics";
import { listAuditEvents } from "@/lib/audit/query";
import { todayISO, addDays } from "@/lib/dates";
import { EXPIRY_REASON } from "@/lib/promotions/lifecycle";
import type { Role } from "@/lib/rbac";
import type { EconomicModel } from "@/lib/engine/types";
import { makeProperty, makeTenant } from "@/test/db";
import * as D from "./decisions";
import { compileForProperty } from "./promotion-compiler";
import { expirePromotions } from "./promotion-lifecycle";
import { declarePromotion, endPromotion } from "./promotion-registry";
import { seedDemo } from "./seed";
import type { Candidate } from "../engine/types";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T, other: T, prop: string, otherProp: string;
const actor = () => ({ ...t.actor, role: "OWNER" as Role });
const NOW = new Date();
const model: EconomicModel = { ...emptyEconomics(), cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } } };
const RAW = { intent: "STIMULATE_NEAR_TERM_DEMAND", stayFrom: addDays(todayISO(), 10), stayTo: addDays(todayISO(), 20), maxDiscountPct: "10", channel_AIRBNB: "on", channel_BOOKING: "on", price_AIRBNB: "200", price_BOOKING: "200" };
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as Error; } throw new Error("aurait dû échouer"); };

beforeAll(async () => {
  t = await makeTenant("cycle"); other = await makeTenant("cycle-autre");
  prop = await makeProperty(t.tenantId, "Châtillon"); otherProp = await makeProperty(other.tenantId, "Autre");
  await db.update(schema.properties).set({ economics: model, strategy: { maxDiscountStackPct: 30 } as never }).where(eq(schema.properties.id, prop));
});

describe("expiration des promotions (US-104)", () => {
  it("termine les promotions dont les séjours sont passés, laisse les autres, consigne, et se rejoue sans effet", async () => {
    const mk = (id: string, tenantId: string, propertyId: string, status: string, stayFrom: string | null, stayTo: string | null) => db.insert(schema.promotions).values({ id, tenantId, propertyId, channel: "BOOKING", kind: "MOBILE", label: id, discountPct: 8, stayFrom, stayTo, status, source: "MANUAL" } as never);
    const y = addDays(todayISO(), -1), tomorrow = addDays(todayISO(), 1);
    await mk("ex-past", t.tenantId, prop, "ACTIVE", addDays(todayISO(), -30), todayISO());
    await mk("ex-planned", t.tenantId, prop, "PLANNED", addDays(todayISO(), -10), y);
    await mk("ex-future", t.tenantId, prop, "ACTIVE", addDays(todayISO(), -2), tomorrow);
    await mk("ex-perm", t.tenantId, prop, "ACTIVE", null, null);
    await mk("ex-other", other.tenantId, otherProp, "ACTIVE", addDays(todayISO(), -9), y);
    const n1 = await expirePromotions(NOW);
    expect(n1).toBeGreaterThanOrEqual(3);
    const st = async (id: string) => (await db.select().from(schema.promotions).where(eq(schema.promotions.id, id)))[0];
    expect(await st("ex-past")).toMatchObject({ status: "ENDED", endReason: EXPIRY_REASON });
    expect((await st("ex-past")).endedAt).not.toBeNull();
    expect((await st("ex-planned")).status).toBe("ENDED");
    expect((await st("ex-future")).status).toBe("ACTIVE");
    expect((await st("ex-perm")).status).toBe("ACTIVE");
    expect((await st("ex-other")).status).toBe("ENDED"); // chaque espace est balayé
    expect(await expirePromotions(NOW)).toBe(0); // rejeu : rien de plus
    await db.delete(schema.promotions).where(eq(schema.promotions.id, "ex-perm")); // ne gêne pas les tests suivants (même type, même canal)
    const ev = (await listAuditEvents(t.tenantId, { limit: 300 })).events.filter((e) => e.type === "promotion.expired");
    expect(ev).toHaveLength(2);
    expect(ev.every((e) => e.entityId === prop)).toBe(true);
    // l'événement d'un espace n'apparaît pas chez l'autre
    expect((await listAuditEvents(other.tenantId, { limit: 300 })).events.filter((e) => e.type === "promotion.expired")).toHaveLength(1);
  });
});

describe("période de repos (US-104)", () => {
  it("après une fin manuelle : le compilateur refuse le même type sur le même canal pendant 7 jours ; une expiration naturelle n'en ouvre pas", async () => {
    const p = await declarePromotion(actor(), prop, { channel: "BOOKING", kind: "MOBILE", discountPct: "8", stayFrom: addDays(todayISO(), 1), stayTo: addDays(todayISO(), 40) }, NOW);
    await endPromotion(actor(), p.id, "Arrêtée par le propriétaire", NOW);
    let r = await compileForProperty(t.tenantId, prop, RAW, NOW);
    const b = r.ok && r.result.outcomes.find((o) => o.channel === "BOOKING");
    expect(b).toMatchObject({ status: "NO_SAFE_EQUIVALENT", code: "COOLDOWN" });
    expect((b as any).reason).toContain("période de repos");
    // Airbnb (autre canal) n'est pas touché
    expect(r.ok && (r.result.outcomes.find((o) => o.channel === "AIRBNB") as any)?.code).not.toBe("COOLDOWN");
    // le repos passé de 7 jours, le compilateur propose de nouveau
    r = await compileForProperty(t.tenantId, prop, RAW, new Date(+NOW + 8 * 86_400_000));
    expect(r.ok && (r.result.outcomes.find((o) => o.channel === "BOOKING") as any)?.code).not.toBe("COOLDOWN");
    // une promotion éteinte par expiration (motif système) n'ouvre aucun repos
    await db.update(schema.promotions).set({ endReason: EXPIRY_REASON }).where(eq(schema.promotions.id, p.id));
    r = await compileForProperty(t.tenantId, prop, RAW, NOW);
    expect(r.ok && (r.result.outcomes.find((o) => o.channel === "BOOKING") as any)?.code).not.toBe("COOLDOWN");
  });

  it("terminer à la main une promotion dont les séjours sont passés n'ouvre aucun repos ; un repos d'un espace n'agit pas chez l'autre", async () => {
    await db.insert(schema.promotions).values({ id: "past-manual", tenantId: t.tenantId, propertyId: prop, channel: "BOOKING", kind: "GENIUS", label: "Genius passée", discountPct: 10, stayFrom: addDays(todayISO(), -30), stayTo: addDays(todayISO(), -1), status: "ACTIVE", source: "MANUAL" } as never);
    await endPromotion(actor(), "past-manual", null, NOW);
    const [row] = await db.select().from(schema.promotions).where(eq(schema.promotions.id, "past-manual"));
    expect(row.endReason).toBe(EXPIRY_REASON);
    const r = await compileForProperty(t.tenantId, prop, { ...RAW, intent: "STIMULATE_TARGET_MARKET" }, NOW);
    expect(r.ok && (r.result.outcomes.find((o) => o.channel === "BOOKING") as any)?.code).not.toBe("COOLDOWN");
    // le repos du premier test (Booking, mobile) ne touche pas le logement de l'autre espace
    await db.update(schema.properties).set({ economics: model, strategy: { maxDiscountStackPct: 30 } as never }).where(eq(schema.properties.id, otherProp));
    const o = await compileForProperty(other.tenantId, otherProp, RAW, NOW);
    expect(o.ok && (o.result.outcomes.find((x) => x.channel === "BOOKING") as any)?.code).not.toBe("COOLDOWN");
  });

  it("déclarer une promotion déjà en ligne reste possible pendant le repos (le registre reflète la réalité)", async () => {
    const p = await declarePromotion(actor(), prop, { channel: "AIRBNB", kind: "LAST_MINUTE", discountPct: "5", stayFrom: addDays(todayISO(), 1), stayTo: addDays(todayISO(), 30) }, NOW).catch(() => null);
    if (p) await endPromotion(actor(), p.id, "test", NOW);
    await expect(declarePromotion(actor(), prop, { channel: "AIRBNB", kind: "LAST_MINUTE", discountPct: "5", stayFrom: addDays(todayISO(), 1), stayTo: addDays(todayISO(), 30) }, NOW)).resolves.toBeTruthy();
  });
});

describe("approbation et seconde relecture (US-104)", () => {
  let demo: T, actionId: string, oppId: string, candIdx: number;
  beforeAll(async () => {
    demo = await makeTenant("cycle-demo"); await seedDemo(demo.tenantId);
    const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, demo.tenantId), eq(schema.opportunities.status, "OPEN")));
    for (const o of opps) {
      const i = (o.candidates as Candidate[]).findIndex((c) => c.type !== "NO_ACTION" && c.audit.verdict !== "REJECT" && c.executionMode === "MANUAL_RUNBOOK");
      if (i < 0) continue;
      oppId = o.id; candIdx = i; break;
    }
    if (!oppId) throw new Error("aucune action manuelle approuvable dans la démonstration");
  }, 120_000);
  const as = (role: Role, who: T = demo) => ({ ...who.actor, role });

  it("approbation d'une promotion de canal refusée pendant la période de repos", async () => {
    const [o] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, oppId));
    const cands = o.candidates as Candidate[];
    const saved = JSON.parse(JSON.stringify(cands));
    cands[candIdx] = { ...cands[candIdx], type: "CHANNEL_PROMO", target: { system: "BOOKING", channel: "BOOKING" }, parameters: { kind: "MOBILE", discountPct: 8, label: "Mobile 8 %", stayFrom: addDays(todayISO(), 5), stayTo: addDays(todayISO(), 15) } } as Candidate;
    await db.update(schema.opportunities).set({ candidates: cands as never }).where(eq(schema.opportunities.id, oppId));
    await db.insert(schema.promotions).values({ id: "rest-1", tenantId: demo.tenantId, propertyId: o.propertyId, channel: "BOOKING", kind: "MOBILE", label: "Tarif mobile", discountPct: 8, stayFrom: addDays(todayISO(), -30), stayTo: addDays(todayISO(), 30), status: "ENDED", endedAt: new Date(), endReason: "Arrêtée à la main", source: "MANUAL" } as never);
    const e = await fail(D.approve(as("OWNER"), oppId, candIdx, "Validé après relecture du dossier."));
    expect(e.message).toContain("période de repos");
    expect((await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, oppId)))).toHaveLength(0);
    // repos terminé : l'approbation passe
    await db.update(schema.promotions).set({ endedAt: new Date(Date.now() - 9 * 86_400_000) }).where(eq(schema.promotions.id, "rest-1"));
    await D.approve(as("OWNER"), oppId, candIdx, "Validé après relecture du dossier.");
    actionId = (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, oppId)))[0].id;
    expect(actionId).toBeTruthy();
    void saved;
  });

  it("vérification d'une action manuelle : refusée pour la personne qui a confirmé avant 24 h, acceptée pour une autre personne", async () => {
    await D.execute(as("OWNER"), actionId, { scope: "Promotion posée sur Booking.com, 8 %", date: todayISO(), proof: "", externalRef: "BK-CYC-1" });
    expect((await fail(D.verify(as("OWNER"), actionId))).message).toContain("autre personne");
    const act = async () => (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, actionId)))[0];
    expect((await act()).status).toBe("EXECUTED");
    expect((await act()).execution.declaredBy).toBe(demo.userId);
    const second = { id: "usr-second", name: "Seconde personne", tenantId: demo.tenantId, role: "REVENUE_MANAGER" as Role };
    await D.verify(second, actionId);
    const a = await act();
    expect(["VERIFIED", "MEASURING"]).toContain(a.status);
    expect(a.execution.verification).toMatchObject({ reread: "OTHER_PERSON" });
  });
});
