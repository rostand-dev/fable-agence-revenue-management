import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { listEconomicsVersions } from "./economics-versions";
import { createProperty, deleteProperty } from "./portfolio";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => (globalThis as any).__user }));
beforeAll(async () => { a = await makeTenant("A-ecv"); b = await makeTenant("B-ecv"); });

const as = (t: T) => { (globalThis as any).__user = t.actor; };
const save = async (t: T, id: string, answers: Record<string, string>) => { as(t); const { saveCostsAction } = await import("@/app/actions/costs"); return saveCostsAction(id, answers as any, false); };
const prop = (id: string) => db.select().from(schema.properties).where(eq(schema.properties.id, id)).then((r) => r[0]);

describe("versions du modèle économique (US-022)", () => {
  it("chaque changement crée une version, avec auteur et détail ; un enregistrement identique n'en crée pas", async () => {
    const id = await makeProperty(a.tenantId, "Versionné");
    await save(a, id, { airbnbPct: "15,5", bookingPct: "17", bookingFeePct: "1,4", cleaningFee: "60" });
    await save(a, id, { airbnbPct: "15,5", bookingPct: "17", bookingFeePct: "1,4", cleaningFee: "60" });
    await save(a, id, { airbnbPct: "15,5", bookingPct: "18", bookingFeePct: "1,4", cleaningFee: "60" });
    expect((await prop(id)).economicsVersion).toBe(2);
    const v = await listEconomicsVersions(a.tenantId, id);
    expect(v.map((x) => x.version)).toEqual([2, 1]);
    expect(v[0]).toMatchObject({ author: a.actor.name, changes: [{ key: "channels.BOOKING.commissionPct", from: "17 %", to: "18 %" }] });
    expect(v[1].changes.length).toBeGreaterThan(3);
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, a.tenantId), eq(schema.auditEvents.entityId, id), eq(schema.auditEvents.type, "property.economics_versioned")));
    expect(ev).toHaveLength(2);
  });
  it("la version de la stratégie ne bouge plus quand le modèle économique change", async () => {
    const id = await makeProperty(a.tenantId, "Stratégie stable");
    const before = (await prop(id)).strategyVersion;
    await save(a, id, { airbnbPct: "12" });
    expect((await prop(id)).strategyVersion).toBe(before);
  });
  it("pendant la création, une sauvegarde d'étape n'est pas versionnée", async () => {
    const { id } = await createProperty(a.actor, { name: "En création", city: "Lille", kind: "T2" });
    await save(a, id, { airbnbPct: "15" });
    expect((await prop(id)).economicsVersion).toBe(0);
    expect(await listEconomicsVersions(a.tenantId, id)).toHaveLength(0);
  });
  it("cloisonnement : l'historique d'un autre espace est vide ; le logement supprimé emporte ses versions", async () => {
    const id = await makeProperty(b.tenantId, "Chez B");
    await save(b, id, { airbnbPct: "15" });
    expect(await listEconomicsVersions(a.tenantId, id)).toHaveLength(0);
    expect(await listEconomicsVersions(b.tenantId, id)).toHaveLength(1);
    await db.update(schema.properties).set({ name: "À retirer" }).where(eq(schema.properties.id, id));
    await deleteProperty(b.actor, id, "À retirer");
    expect(await db.select().from(schema.economicModelVersions).where(eq(schema.economicModelVersions.propertyId, id))).toHaveLength(0);
  });
  it("numéros uniques même avec deux enregistrements simultanés", async () => {
    const id = await makeProperty(a.tenantId, "Course");
    await Promise.all([save(a, id, { airbnbPct: "10" }), save(a, id, { airbnbPct: "11" })]);
    const nums = (await listEconomicsVersions(a.tenantId, id)).map((x) => x.version).sort();
    expect(new Set(nums).size).toBe(nums.length);
  });
});
describe("migration 0016 (versions du modèle économique)", () => {
  const st = fs.readFileSync(path.join(process.cwd(), "drizzle", "0016_economic_versions.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
  it("reprend un logement existant en version 1, sans doublon au second passage", async () => {
    const t = await makeTenant("C-ecv");
    const id = await makeProperty(t.tenantId, "Ancien");
    await db.update(schema.properties).set({ economics: { channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 } }, cleaningFeeChargedCents: 5000, origin: "DECLARED", answers: { x: 1 } } as any }).where(eq(schema.properties.id, id));
    for (let i = 0; i < 2; i++) for (const s of st) await db.execute(sql.raw(s));
    const v = await db.select().from(schema.economicModelVersions).where(eq(schema.economicModelVersions.propertyId, id));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ version: 1, createdBy: "system" });
    expect((v[0].model as any).answers).toBeUndefined();
    expect((await prop(id)).economicsVersion).toBe(1);
  });
});
