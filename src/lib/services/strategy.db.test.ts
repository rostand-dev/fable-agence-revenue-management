import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { createProperty, PortfolioError } from "./portfolio";
import { commitStrategy, discardDraft, getStrategyState, publishDraft, rollbackToVersion, saveDraft } from "./strategy";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
beforeAll(async () => { a = await makeTenant("A-strat"); b = await makeTenant("B-strat"); });

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof PortfolioError) return e.code + ": " + e.message; throw e; } throw new Error("aurait dû échouer"); };
const prop = (id: string) => db.select().from(schema.properties).where(eq(schema.properties.id, id)).then((r) => r[0]);
const events = (t: T, type: string) => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, type)));
/** Logement lancé avec une stratégie connue et sa version de départ. */
async function launched(t: T, name: string) {
  const id = await makeProperty(t.tenantId, name);
  const strategy = { basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 21000, minStay: 2, objective: "Objectif A", positioning: "Pro", maxDiscountStackPct: 20, maxPriceChangePct: 5 };
  await db.update(schema.properties).set({ strategy, strategyVersion: 1 }).where(eq(schema.properties.id, id));
  await db.insert(schema.strategyVersions).values({ id: "stv_seed_" + id, tenantId: t.tenantId, propertyId: id, version: 1, strategy, changes: [], source: "SYSTEM", createdBy: "system" });
  return id;
}

describe("Strategy Builder (US-023)", () => {
  it("le brouillon n'a aucun effet ; la publication crée une version avec auteur, note et détail", async () => {
    const id = await launched(a, "Builder 1");
    await saveDraft(a.actor, id, { minStay: "3", maxDiscountStackPct: "15" });
    expect((await prop(id)).strategyVersion).toBe(1);
    expect((await prop(id)).strategy).toMatchObject({ minStay: 2, maxDiscountStackPct: 20 });
    const s = await getStrategyState(a.tenantId, id);
    expect(s.draft?.changes.map((c) => c.key)).toEqual(["minStay", "maxDiscountStackPct"]);
    expect(s.draft?.stale).toBe(false);
    expect(await publishDraft(a.actor, id, "Séjours un peu plus longs")).toBe(2);
    const after = await prop(id);
    expect(after).toMatchObject({ strategyVersion: 2, strategyDraft: null });
    expect(after.strategy).toMatchObject({ minStay: 3, maxDiscountStackPct: 15, basePriceCents: 11600, minPriceCents: 8300 });
    const v = (await getStrategyState(a.tenantId, id)).versions;
    expect(v.map((x) => x.version)).toEqual([2, 1]);
    expect(v[0]).toMatchObject({ source: "BUILDER", note: "Séjours un peu plus longs", author: a.actor.name });
    expect(v[0].changes.map((c) => c.key)).toEqual(["minStay", "maxDiscountStackPct"]);
    expect((await events(a, "strategy.published")).some((e) => e.entityId === id)).toBe(true);
  });
  it("validation : valeurs hors bornes refusées, brouillon identique non publiable, rien à publier sans brouillon", async () => {
    const id = await launched(a, "Builder 2");
    expect(await code(saveDraft(a.actor, id, { maxDiscountStackPct: "80" }))).toMatch(/^INVALID: Le cumul/);
    expect(await code(publishDraft(a.actor, id, ""))).toMatch(/^INVALID: Il n'y a pas de brouillon/);
    await saveDraft(a.actor, id, { minStay: "2" });
    expect(await code(publishDraft(a.actor, id, ""))).toMatch(/^INVALID: Le brouillon est identique/);
    expect((await prop(id)).strategyVersion).toBe(1);
  });
  it("abandonner le brouillon le supprime, tracé", async () => {
    const id = await launched(a, "Builder 3");
    await saveDraft(a.actor, id, { positioning: "Famille" });
    await discardDraft(a.actor, id);
    expect((await prop(id)).strategyDraft).toBeNull();
    expect((await events(a, "strategy.draft_discarded")).some((e) => e.entityId === id)).toBe(true);
  });
  it("un changement de prix seul n'invalide pas le brouillon ; un changement de réglage l'invalide", async () => {
    const id = await launched(a, "Builder 4");
    await saveDraft(a.actor, id, { maxPriceChangePct: "8" });
    await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, basePriceCents: 12000 }), source: "PRICELABS_SYNC", createdBy: "system" }));
    expect((await getStrategyState(a.tenantId, id)).draft?.stale).toBe(false);
    await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, minStay: 4 }), source: "FORM", createdBy: "system" }));
    expect((await getStrategyState(a.tenantId, id)).draft?.stale).toBe(true);
    expect(await code(publishDraft(a.actor, id, ""))).toMatch(/^CONFLICT: La stratégie a changé depuis ce brouillon/);
    await saveDraft(a.actor, id, { maxPriceChangePct: "8" }); // enregistré de nouveau sur la version en vigueur
    expect(await publishDraft(a.actor, id, "")).toBe(4);
  });
  it("mise à jour perdue : enregistrer sur une version dont les réglages ont changé est refusé (409)", async () => {
    const id = await launched(a, "Builder lost");
    await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, minStay: 5 }), source: "FORM", createdBy: "system" }));
    expect(await code(saveDraft(a.actor, id, { minStay: "3" }, 1))).toMatch(/^CONFLICT:/);
    await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, basePriceCents: 12500 }), source: "PRICELABS_SYNC", createdBy: "system" }));
    await saveDraft(a.actor, id, { minStay: "3" }, 2); // seul un prix a changé depuis la version 2 → accepté
    expect((await prop(id)).strategyDraft).not.toBeNull();
  });
  it("un logement lancé sans version enregistrée reçoit d'abord sa version de départ", async () => {
    const id = await makeProperty(a.tenantId, "Sans historique");
    await db.update(schema.properties).set({ strategy: { basePriceCents: 10000, minStay: 2 }, strategyVersion: 1 }).where(eq(schema.properties.id, id));
    await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, minStay: 3 }), source: "FORM", createdBy: "system" }));
    expect((await getStrategyState(a.tenantId, id)).versions.map((v) => [v.version, v.source])).toEqual([[2, "FORM"], [1, "SYSTEM"]]);
  });
  it("la restauration efface un brouillon devenu sans objet", async () => {
    const id = await launched(a, "Builder rb");
    await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, minStay: 6 }), source: "FORM", createdBy: "system" }));
    await saveDraft(a.actor, id, { minStay: "3" });
    await rollbackToVersion(a.actor, id, 1, "");
    expect((await prop(id)).strategyDraft).toBeNull();
  });
  it("restauration : nouvelle version avec les réglages d'avant, sans toucher aux prix ; l'historique n'est jamais réécrit", async () => {
    const id = await launched(a, "Builder 5");
    await saveDraft(a.actor, id, { objective: "Objectif B", minStay: "4" }); await publishDraft(a.actor, id, "");
    await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, basePriceCents: 13000 }), source: "ACTION", createdBy: a.userId }));
    expect(await rollbackToVersion(a.actor, id, 1, "On revient")).toBe(4);
    const p = await prop(id);
    expect(p.strategy).toMatchObject({ objective: "Objectif A", minStay: 2, basePriceCents: 13000 }); // les prix du moment restent
    const v = (await getStrategyState(a.tenantId, id)).versions;
    expect(v.map((x) => x.version)).toEqual([4, 3, 2, 1]);
    expect(v[0]).toMatchObject({ source: "ROLLBACK", note: "On revient" });
    expect(await code(rollbackToVersion(a.actor, id, 4, ""))).toMatch(/^INVALID: Cette version est déjà en vigueur/);
    expect(await code(rollbackToVersion(a.actor, id, 99, ""))).toMatch(/^NOT_FOUND/);
    expect((await events(a, "strategy.rolled_back")).some((e) => e.entityId === id)).toBe(true);
  });
  it("démo et logement en création : refusés ; autre espace : introuvable et intouchable", async () => {
    const { id: draftId } = await createProperty(a.actor, { name: "En création", city: "Lille", kind: "T2" });
    expect(await code(saveDraft(a.actor, draftId, { minStay: "3" }))).toMatch(/^INVALID: Ce logement est en cours de création/);
    const [demo] = await db.insert(schema.properties).values({ id: "prop_demo_strat_" + Date.now(), tenantId: a.tenantId, name: "Démo", city: "Paris", kind: "T2", status: "ACTIVE", isDemo: true }).returning();
    expect(await code(saveDraft(a.actor, demo.id, { minStay: "3" }))).toMatch(/^INVALID: Un logement de démonstration/);
    const idB = await launched(b, "Chez B");
    expect(await code(saveDraft(a.actor, idB, { minStay: "3" }))).toMatch(/^NOT_FOUND/);
    expect(await code(publishDraft(a.actor, idB, ""))).toMatch(/^NOT_FOUND/);
    expect(await code(rollbackToVersion(a.actor, idB, 1, ""))).toMatch(/^NOT_FOUND/);
    expect(await code(getStrategyState(a.tenantId, idB))).toMatch(/^NOT_FOUND/);
  });
  it("deux publications simultanées : numéros distincts, aucune version perdue", async () => {
    const id = await launched(a, "Course");
    await Promise.all([1, 2, 3].map((n) => db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, minStay: 10 + n }), source: "FORM", createdBy: a.userId }))));
    const nums = (await getStrategyState(a.tenantId, id)).versions.map((v) => v.version).sort();
    expect(nums).toEqual([1, 2, 3, 4]);
    expect((await prop(id)).strategyVersion).toBe(4);
  });
  it("le changement est consigné quelle que soit l'origine (formulaire, relecture PriceLabs, action)", async () => {
    const id = await launched(a, "Sources");
    for (const source of ["FORM", "PRICELABS_SYNC", "ACTION", "ACTION_ROLLBACK"] as const) await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => ({ ...s, basePriceCents: (s.basePriceCents ?? 0) + 100 }), source, createdBy: "system" }));
    expect((await getStrategyState(a.tenantId, id)).versions.map((v) => v.source)).toEqual(["ACTION_ROLLBACK", "ACTION", "PRICELABS_SYNC", "FORM", "SYSTEM"]);
    // aucun changement : aucune version
    expect(await db.transaction((tx) => commitStrategy(tx, { tenantId: a.tenantId, propertyId: id, next: (s) => s, source: "FORM", createdBy: "system" }))).toBeNull();
  });
});
describe("migration 0017 (versions de la stratégie)", () => {
  it("reprend les logements lancés en version de départ, sans doublon, hors démo et création", async () => {
    const t = await makeTenant("C-strat");
    const id = await makeProperty(t.tenantId, "Ancien");
    await db.update(schema.properties).set({ strategyVersion: 7, strategy: { basePriceCents: 10000 } as any }).where(eq(schema.properties.id, id));
    const draft = await makeProperty(t.tenantId, "En création");
    await db.update(schema.properties).set({ status: "ONBOARDING" }).where(eq(schema.properties.id, draft));
    const st = fs.readFileSync(path.join(process.cwd(), "drizzle", "0017_strategy_versions.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    for (let i = 0; i < 2; i++) for (const s of st) await db.execute(sql.raw(s));
    const v = await db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.propertyId, id));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ version: 7, source: "SYSTEM", createdBy: "system" });
    expect(await db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.propertyId, draft))).toHaveLength(0);
  });
});
