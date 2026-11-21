import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { floorFingerprint } from "@/lib/activation-gates";
import type { EconomicModel } from "@/lib/engine/types";
import { makeTenant } from "@/test/db";
import { confirmMapping, getMapping } from "./mapping";
import { createProperty, PortfolioError } from "./portfolio";
import { activateProperty, getQuality } from "./quality";
import { getValidations, recordReconciliation, validateFloors } from "./validations";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
beforeAll(async () => { a = await makeTenant("A-val"); b = await makeTenant("B-val"); });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof PortfolioError) return e.code + ": " + e.message; throw e; } throw new Error("aurait dû échouer"); };
const ECON = { cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 } } };
const fp = (e: object = ECON) => floorFingerprint(e as unknown as EconomicModel)!;
const rows = (t: T, id: string, kind?: string) => db.select().from(schema.activationValidations).where(and(eq(schema.activationValidations.tenantId, t.tenantId), eq(schema.activationValidations.propertyId, id), ...(kind ? [eq(schema.activationValidations.kind, kind)] : [])));
const events = (t: T, type: string) => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, type)));

/** Logement en observation depuis `days` jours, économie complète, mapping confirmé : seules les validations manquent. */
async function shadow(t: T, name: string, days = 20) {
  const { id } = await createProperty(t.actor, { name, city: "Lille", kind: "T2", bedrooms: 2 });
  await db.update(schema.properties).set({
    status: "SHADOW", economics: ECON as never, strategy: { basePriceCents: 12000, minPriceCents: 8000, maxPriceCents: 20000, minStay: 2 } as never,
    pricelabs: { apiKeyEnc: "x", listingId: "pl1", pms: "superhote", listingName: "Annonce", candidates: [{ id: "pl1", pms: "superhote", name: "Annonce", city: "Lille", bedrooms: 2 }], lastSync: { ok: true, at: new Date().toISOString(), days: 90 } } as never,
    onboarding: { step: "verification", completedAt: new Date(Date.now() - days * 86_400_000).toISOString() } as never,
  }).where(eq(schema.properties.id, id));
  await confirmMapping(t.actor, id, false, (await getMapping(t.tenantId, id)).fingerprint);
  return id;
}

describe("validations avant activation (US-024)", () => {
  it("sans validation : les trois points restent bloquants, l'activation est refusée avec le détail", async () => {
    const id = await shadow(a, "Sans validation", 3);
    const q = await getQuality(a.tenantId, id);
    expect(q.blockers).toEqual(["shadow", "floors", "reconciliation"]);
    expect(await code(activateProperty(a.actor, id))).toMatch(/Observation d'au moins 14 jours \(Observation depuis 3 jours sur 14/);
  });
  it("planchers : validation tracée, grille et empreinte conservées ; périmée dès que les coûts changent", async () => {
    const id = await shadow(a, "Planchers");
    await validateFloors(a.actor, id, fp(), "relu avec le propriétaire");
    const [r] = await rows(a, id, "FLOORS");
    expect(r).toMatchObject({ fingerprint: fp(), validatedBy: a.actor.id, note: "relu avec le propriétaire" });
    expect((r.payload as { grid: unknown[] }).grid).toHaveLength(3); // 1 canal × 2, 7 et 28 nuits
    expect((await events(a, "property.floors_validated")).filter((e) => e.entityId === id)).toHaveLength(1);
    expect((await getQuality(a.tenantId, id)).blockers).not.toContain("floors");
    await db.update(schema.properties).set({ economics: { ...ECON, cleaningCostCents: 4500 } as never }).where(eq(schema.properties.id, id));
    expect((await getQuality(a.tenantId, id)).blockers).toContain("floors");
    expect((await getValidations(a.tenantId, id)).floors.status).toBe("STALE");
  });
  it("planchers : refusée si la grille a changé depuis l'affichage, si le modèle est incomplet, ou si l'empreinte est absente", async () => {
    const id = await shadow(a, "Planchers refus");
    expect(await code(validateFloors(a.actor, id, undefined, ""))).toMatch(/^CONFLICT/);
    expect(await code(validateFloors(a.actor, id, "0".repeat(32), ""))).toMatch(/^CONFLICT: Les planchers ont changé/);
    expect(await code(validateFloors(a.actor, id, fp(), "x".repeat(301)))).toMatch(/300 caractères/);
    await db.update(schema.properties).set({ economics: {} as never }).where(eq(schema.properties.id, id));
    expect(await code(validateFloors(a.actor, id, fp(), ""))).toMatch(/^INVALID: .*incomplet/);
    expect(await rows(a, id)).toHaveLength(0);
  });
  it("rapprochement : enregistré même insuffisant, la checklist dit pourquoi ; la dernière attestation fait foi", async () => {
    const id = await shadow(a, "Rapprochement");
    await recordReconciliation(a.actor, id, { sampleSize: "6", maxGapPct: "0", source: "SuperHote" });
    expect((await getQuality(a.tenantId, id)).items.find((i) => i.key === "reconciliation")?.detail).toMatch(/trop petit : 6 réservations/);
    await recordReconciliation(a.actor, id, { sampleSize: "12", maxGapPct: "2,3", source: "SuperHote" });
    expect((await getQuality(a.tenantId, id)).items.find((i) => i.key === "reconciliation")?.detail).toMatch(/2,3 %, au-delà de 1 %/);
    await recordReconciliation(a.actor, id, { sampleSize: "12", maxGapPct: "0,6", source: "SuperHote comparé aux relevés Airbnb" });
    expect((await getQuality(a.tenantId, id)).blockers).not.toContain("reconciliation");
    expect(await rows(a, id, "RECONCILIATION")).toHaveLength(3);
    expect((await events(a, "property.reconciliation_recorded")).filter((e) => e.entityId === id)).toHaveLength(3);
    expect(await code(recordReconciliation(a.actor, id, { sampleSize: "abc", maxGapPct: "0", source: "SuperHote" }))).toMatch(/^INVALID/);
    expect(await rows(a, id, "RECONCILIATION")).toHaveLength(3);
  });
  it("tout validé et observation de 14 jours écoulés : l'activation passe ; à 13 jours elle est refusée", async () => {
    const early = await shadow(a, "Treize jours", 13);
    await validateFloors(a.actor, early, fp(), ""); await recordReconciliation(a.actor, early, { sampleSize: "10", maxGapPct: "1", source: "SuperHote" });
    expect((await getQuality(a.tenantId, early)).blockers).toEqual(["shadow"]);
    expect(await code(activateProperty(a.actor, early))).toMatch(/Observation d'au moins 14 jours/);
    const ok = await shadow(a, "Quatorze jours", 14);
    await validateFloors(a.actor, ok, fp(), ""); await recordReconciliation(a.actor, ok, { sampleSize: "10", maxGapPct: "1", source: "SuperHote" });
    await activateProperty(a.actor, ok);
    expect((await db.select().from(schema.properties).where(eq(schema.properties.id, ok)))[0].status).toBe("ACTIVE");
  });
  it("statuts et espaces : ni création, ni démonstration, ni logement actif, ni autre espace", async () => {
    const { id: onb } = await createProperty(a.actor, { name: "En création", city: "Lille", kind: "T2" });
    expect(await code(validateFloors(a.actor, onb, fp(), ""))).toMatch(/^INVALID: Les validations se font une fois l'observation/);
    expect(await code(recordReconciliation(a.actor, onb, { sampleSize: "12", maxGapPct: "0", source: "SuperHote" }))).toMatch(/^INVALID/);
    const demo = await shadow(a, "Démo"); await db.update(schema.properties).set({ isDemo: true }).where(eq(schema.properties.id, demo));
    expect(await code(validateFloors(a.actor, demo, fp(), ""))).toMatch(/démonstration/);
    const act = await shadow(a, "Déjà actif"); await db.update(schema.properties).set({ status: "ACTIVE" }).where(eq(schema.properties.id, act));
    expect(await code(recordReconciliation(a.actor, act, { sampleSize: "12", maxGapPct: "0", source: "SuperHote" }))).toMatch(/déjà actif/);
    const id = await shadow(a, "Autre espace");
    expect(await code(validateFloors(b.actor, id, fp(), ""))).toMatch(/^NOT_FOUND/);
    expect(await code(recordReconciliation(b.actor, id, { sampleSize: "12", maxGapPct: "0", source: "SuperHote" }))).toMatch(/^NOT_FOUND/);
    expect(await code(getValidations(b.tenantId, id) as Promise<unknown>)).toMatch(/^NOT_FOUND/);
    expect(await rows(a, id)).toHaveLength(0);
  });
  it("courses : deux validations simultanées gardent la dernière ; validation et activation simultanées ne laissent pas un logement actif sans validation", async () => {
    const id = await shadow(a, "Courses");
    await Promise.all([validateFloors(a.actor, id, fp(), "première"), validateFloors(a.actor, id, fp(), "seconde")]);
    expect(await rows(a, id, "FLOORS")).toHaveLength(2);
    await recordReconciliation(a.actor, id, { sampleSize: "12", maxGapPct: "0", source: "SuperHote" });
    const r = await Promise.allSettled([activateProperty(a.actor, id), validateFloors(a.actor, id, fp(), "pendant l'activation")]);
    const st = (await db.select().from(schema.properties).where(eq(schema.properties.id, id)))[0].status;
    expect(st).toBe("ACTIVE");
    expect(r[0].status).toBe("fulfilled");
    if (r[1].status === "rejected") expect(String(r[1].reason.message)).toMatch(/déjà actif/);
  });
  it("coûts modifiés pendant la validation : la grille périmée est refusée ou la validation devient périmée, jamais valide à tort", async () => {
    const id = await shadow(a, "Course coûts");
    const changed = { ...ECON, cleaningCostCents: 4500 };
    await Promise.allSettled([validateFloors(a.actor, id, fp(), ""), db.update(schema.properties).set({ economics: changed as never }).where(eq(schema.properties.id, id))]);
    const v = await getValidations(a.tenantId, id);
    expect(v.fingerprint).toBe(fp(changed));
    expect(v.floors.status).toMatch(/^(STALE|NONE)$/);
    expect((await getQuality(a.tenantId, id)).blockers).toContain("floors");
  });
  it("écart de 1,04 % : enregistré mais insuffisant ; date de lancement future : observation non satisfaite", async () => {
    const id = await shadow(a, "Limites");
    await validateFloors(a.actor, id, fp(), "");
    await recordReconciliation(a.actor, id, { sampleSize: "12", maxGapPct: "1,04", source: "SuperHote" });
    expect((await getQuality(a.tenantId, id)).blockers).toEqual(["reconciliation"]);
    await db.update(schema.properties).set({ onboarding: { step: "verification", completedAt: new Date(Date.now() + 86_400_000).toISOString() } as never }).where(eq(schema.properties.id, id));
    expect((await getQuality(a.tenantId, id)).blockers).toContain("shadow");
  });
  it("ACTIVATION_SHADOW_MIN_DAYS : 0 lève le délai (floors et rapprochement restent exigés), valeur invalide = 14, durée appliquée tracée", async () => {
    const saved = process.env.ACTIVATION_SHADOW_MIN_DAYS;
    try {
      const id = await shadow(a, "Délai nul", 1);
      process.env.ACTIVATION_SHADOW_MIN_DAYS = "abc";
      expect((await getQuality(a.tenantId, id)).blockers).toEqual(["shadow", "floors", "reconciliation"]);
      process.env.ACTIVATION_SHADOW_MIN_DAYS = "0";
      expect((await getQuality(a.tenantId, id)).blockers).toEqual(["floors", "reconciliation"]); // seul le délai disparaît
      await validateFloors(a.actor, id, fp(), ""); await recordReconciliation(a.actor, id, { sampleSize: "10", maxGapPct: "0", source: "SuperHote" });
      await activateProperty(a.actor, id);
      const ev = (await events(a, "property.activated")).find((e) => e.entityId === id)!;
      expect((ev.payload as { shadowMinDays: number }).shadowMinDays).toBe(0);
      const none = await shadow(a, "Sans date", 1);
      await db.update(schema.properties).set({ onboarding: { step: "verification" } as never }).where(eq(schema.properties.id, none));
      expect((await getQuality(a.tenantId, none)).items.find((i) => i.key === "shadow")?.ok).toBe(false); // date de lancement inconnue : même à 0
    } finally { if (saved === undefined) delete process.env.ACTIVATION_SHADOW_MIN_DAYS; else process.env.ACTIVATION_SHADOW_MIN_DAYS = saved; }
  });
});
