import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { addDays, todayISO } from "@/lib/dates";
import type { Role } from "@/lib/rbac";
import { makeTenant } from "@/test/db";
import type { Candidate } from "../engine/types";
import * as D from "./decisions";
import { countOverlapping, getExperimentOfAction, getMeasurementOfAction, reservationsFreshFor } from "./experiments";
import { seedDemo } from "./seed";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T, other: T;
const as = (role: Role) => ({ ...t.actor, role });
const actionRow = async (id: string) => (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, id)))[0];
const used = new Set<string>();
async function approveOne(mode: "API_PRICELABS" | "MANUAL_RUNBOOK"): Promise<string> {
  const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
  for (const o of opps) {
    if (used.has(o.id)) continue;
    const i = (o.candidates as Candidate[]).findIndex((c) => c.type !== "NO_ACTION" && c.audit.verdict !== "REJECT" && c.executionMode === mode);
    if (i < 0) continue;
    await D.approve(as("OWNER"), o.id, i, "Validé après relecture du dossier.");
    used.add(o.id);
    return (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, o.id)))[0].id;
  }
  throw new Error(`aucune option ${mode} approuvable dans la démonstration`);
}
/** Exécute, vérifie, puis rend la mesure exigible : la fenêtre d'observation, elle, reste celle fixée à la vérification. */
async function toMeasuring(actionId: string) {
  await D.execute(as("OWNER"), actionId);
  await D.verify(as("OWNER"), actionId);
  await db.update(schema.revenueActions).set({ measureDueAt: addDays(todayISO(), -1) }).where(eq(schema.revenueActions.id, actionId));
}
let a1: string, a2: string, a3: string;

beforeAll(async () => {
  t = await makeTenant("mesures"); other = await makeTenant("mesures-autre"); await seedDemo(t.tenantId);
  a1 = await approveOne("API_PRICELABS");
  a2 = await approveOne("API_PRICELABS").catch(() => approveOne("MANUAL_RUNBOOK"));
  a3 = await approveOne("MANUAL_RUNBOOK").catch(() => a2);
}, 180_000);

describe("mesure d'une expérience (US-111)", () => {
  it("la mesure s'appuie sur la référence figée : résultat classé, mesure écrite avec la clôture, expérience mesurée, jamais d'effet attribué", async () => {
    await toMeasuring(a1);
    expect(await D.measureDueActions(t.tenantId, todayISO())).toBeGreaterThanOrEqual(1);
    const [a, x, m] = [await actionRow(a1), (await getExperimentOfAction(t.tenantId, a1))!, (await getMeasurementOfAction(t.tenantId, a1))!];
    expect(a.status).toBe("CLOSED");
    expect(x.status).toBe("MEASURED");
    expect(m).toBeTruthy();
    expect(["POSITIVE", "NEUTRAL", "NEGATIVE", "INCONCLUSIVE"]).toContain(m.outcome);
    expect(m.experimentId).toBe(x.id);
    expect(m.legacy).toBe(false);
    expect(m.observeFrom).toBe(x.observeFrom);
    expect(m.observeTo).toBe(x.observeTo);
    expect(m.confidence).toBe("faible");
    // l'écran existant lit encore le résultat sur l'action : même résultat, même texte
    expect(a.measurement.outcome).toBe(m.outcome);
    expect(a.measurement.observed).toBe(m.summary);
    expect(a.measurement.incrementalCents).toBeNull();
    expect(a.measurement.experimentId).toBe(x.id);
    const audits = await db.execute(sql`select summary, payload from audit_events where tenant_id = ${t.tenantId} and type = 'experiment.measured' and entity_id = ${a1}`).then((r) => r.rows as { summary: string; payload: any }[]);
    expect(audits).toHaveLength(1);
    expect(audits[0].payload.outcome).toBe(m.outcome);
    expect(audits[0].payload.experimentId).toBe(x.id);
  });

  it("une mesure rendue ne se réécrit pas (déclencheur) ; une seule mesure par expérience", async () => {
    const m = (await getMeasurementOfAction(t.tenantId, a1))!;
    const err = await db.update(schema.experimentMeasurements).set({ outcome: "POSITIVE" }).where(eq(schema.experimentMeasurements.id, m.id)).then(() => null, (e) => e as { message?: string; cause?: { message?: string } });
    expect(err).not.toBeNull();
    expect(`${err!.message} ${err!.cause?.message ?? ""}`).toMatch(/figée/);
    await expect(db.insert(schema.experimentMeasurements).values({ ...m, id: "mes_dup" })).rejects.toThrow();
    expect((await getMeasurementOfAction(t.tenantId, a1))!.outcome).toBe(m.outcome);
  });

  it("action sans expérience (base antérieure) : expérience héritée créée, mesure non concluante, rien n'est inventé", async () => {
    await toMeasuring(a2);
    await db.delete(schema.experiments).where(eq(schema.experiments.actionId, a2));
    await D.measureDueActions(t.tenantId, todayISO());
    const m = (await getMeasurementOfAction(t.tenantId, a2))!;
    expect(m.outcome).toBe("INCONCLUSIVE");
    expect(m.reasons).toContain("LEGACY");
    expect(m.legacy).toBe(true); // une mesure sans référence figée est marquée héritée : le rapport et l'historique peuvent la distinguer
    expect((m.metrics as any).observedNights).toBeNull();
    expect((await getExperimentOfAction(t.tenantId, a2))!.status).toBe("MEASURED");
  });

  it("isolation : un autre espace ne voit ni la mesure ni l'expérience", async () => {
    expect(await getMeasurementOfAction(other.tenantId, a1)).toBeNull();
    expect(await getExperimentOfAction(other.tenantId, a1)).toBeNull();
  });
});

describe("garde-fous de la mesure (US-111)", () => {
  it("réservations : démonstration toujours fraîche ; SuperHote en échec ou trop ancien = non frais ; récent = frais ; sans liaison SuperHote, rien n'est opposé", async () => {
    const [p] = await db.select().from(schema.properties).where(eq(schema.properties.tenantId, t.tenantId));
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(true);
    const real = (superhote: any) => db.update(schema.properties).set({ isDemo: false, superhote }).where(eq(schema.properties.id, p.id));
    await real({ rentalId: "42", lastSync: { ok: true, at: new Date(Date.now() - 3 * 86_400_000).toISOString() } });
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(false);
    await real({ rentalId: "42", lastSync: { ok: false, at: new Date().toISOString() } });
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(false);
    await real({ rentalId: "42", lastSync: { ok: true, at: new Date(Date.now() - 3_600_000).toISOString() } });
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(true);
    await real({ rentalId: "42" });
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(false);
    // sans SuperHote, PriceLabs porte les réservations : sa lecture en échec ou ancienne rend la mesure non fiable
    const pl = (lastSync: any) => db.update(schema.properties).set({ isDemo: false, superhote: null, pricelabs: { listingId: "pl-1", lastSync } as any }).where(eq(schema.properties.id, p.id));
    await pl({ ok: true, at: new Date(Date.now() - 3_600_000).toISOString() });
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(true);
    await pl({ ok: true, at: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(false);
    await pl({ ok: false, at: new Date().toISOString() });
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(false);
    await db.update(schema.properties).set({ pricelabs: null }).where(eq(schema.properties.id, p.id));
    await real(null);
    expect(await reservationsFreshFor(t.tenantId, p.id)).toBe(true);
    await db.update(schema.properties).set({ isDemo: true }).where(eq(schema.properties.id, p.id));
    expect(await reservationsFreshFor(other.tenantId, p.id)).toBe(true); // propriété d'un autre espace : jamais lue
  });

  it("autre action mêlée : mêmes séjours et observation simultanée comptent ; annulée, autre logement ou séjours disjoints non", async () => {
    await D.execute(as("OWNER"), a3).catch(() => {});
    const x = (await getExperimentOfAction(t.tenantId, a1))!;
    const base = { stayFrom: x.stayFrom ?? "2030-01-10", stayTo: x.stayTo ?? "2030-01-20" };
    const mk = async (id: string, over: Partial<typeof schema.experiments.$inferInsert>) => {
      // une action jetable par expérience factice (clé unique sur l'action)
      const src = await actionRow(a1);
      const { id: _i, idempotencyKey: _k, ...rest } = src as any;
      await db.insert(schema.revenueActions).values({ ...rest, id: `act_${id}`, idempotencyKey: `k_${id}`, status: "DRAFT", executedAt: null, execution: null, verifiedAt: null, measureDueAt: null, measurement: null });
      await db.insert(schema.experiments).values({ id: `exp_${id}`, tenantId: t.tenantId, propertyId: x.propertyId, actionId: `act_${id}`, opportunityId: x.opportunityId, status: "OBSERVING", effectiveOn: x.effectiveOn, stayFrom: base.stayFrom, stayTo: base.stayTo, baselineFrom: x.effectiveOn, baselineTo: x.effectiveOn, observeFrom: x.effectiveOn, observeTo: addDays(x.effectiveOn, 7), baseline: { version: 0, legacy: true }, ...over });
    };
    const probe = { ...x, id: "exp_probe", observeFrom: x.effectiveOn, observeTo: addDays(x.effectiveOn, 7) };
    // les expériences déjà présentes (mesurées ou en cours) comptent aussi : on compte les écarts
    const n0 = await countOverlapping(t.tenantId, probe);
    await mk("ov1", {});
    expect(await countOverlapping(t.tenantId, probe)).toBe(n0 + 1);
    await mk("ov2", { status: "CANCELLED" });
    await mk("ov3", { stayFrom: addDays(base.stayTo, 5), stayTo: addDays(base.stayTo, 9) });
    await mk("ov4", { effectiveOn: addDays(x.effectiveOn, 30), observeFrom: addDays(x.effectiveOn, 30), observeTo: addDays(x.effectiveOn, 37) });
    expect(await countOverlapping(t.tenantId, probe)).toBe(n0 + 1);
    await mk("ov5", { status: "AWAITING_VERIFICATION", observeFrom: null, observeTo: null });
    expect(await countOverlapping(t.tenantId, probe)).toBe(n0 + 2);
    // une expérience héritée déjà mesurée, sans fin d'observation, ne mêle plus rien après son entrée en vigueur
    await mk("ov6", { status: "MEASURED", effectiveOn: addDays(x.effectiveOn, -60), observeFrom: null, observeTo: null });
    expect(await countOverlapping(t.tenantId, probe)).toBe(n0 + 2);
    expect(await countOverlapping(other.tenantId, { ...probe, propertyId: probe.propertyId })).toBe(0);
    expect(await countOverlapping(t.tenantId, { ...probe, stayFrom: null, stayTo: null })).toBe(0);
  });
});
