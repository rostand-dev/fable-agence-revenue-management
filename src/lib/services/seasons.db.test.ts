import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { floorFingerprint } from "@/lib/activation-gates";
import type { EconomicModel } from "@/lib/engine/types";
import { makeTenant } from "@/test/db";
import { listEconomicsVersions } from "./economics-versions";
import { createProperty, PortfolioError } from "./portfolio";
import { getFloors, saveSeasons } from "./seasons";
import { getValidations, validateFloors } from "./validations";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => (globalThis as any).__user }));
beforeAll(async () => { a = await makeTenant("A-sea"); b = await makeTenant("B-sea"); });

const ECON = { cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 } } };
const SUMMER = { label: "Été", from: "07-01", to: "08-31", strategyContributionPerNightCents: 6000 };
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof PortfolioError) return e.code + ": " + e.message; throw e; } throw new Error("aurait dû échouer"); };
const prop = (id: string) => db.select().from(schema.properties).where(eq(schema.properties.id, id)).then((r) => r[0]);
async function make(t: T, name: string, over: Record<string, unknown> = {}) {
  const { id } = await createProperty(t.actor, { name, city: "Lille", kind: "T2" });
  await db.update(schema.properties).set({ status: "SHADOW", economics: ECON as never, ...over }).where(eq(schema.properties.id, id));
  return id;
}

describe("saisons du plancher (US-052)", () => {
  it("enregistre les saisons : une version du modèle, un audit, la grille saisonnière ; rejouer à l'identique ne crée rien", async () => {
    const id = await make(a, "Saisonnier");
    const r = await saveSeasons(a.actor, id, [SUMMER]);
    expect(r.version).toBe(1);
    expect((await prop(id)).economicsVersion).toBe(1);
    const v = await listEconomicsVersions(a.tenantId, id);
    expect(v[0].changes).toEqual([{ key: "seasons.s1", label: "Saison « Été »", from: null, to: "« Été » 07-01 → 08-31 : 60,00 € par nuit" }]);
    const f = await getFloors(a.tenantId, id);
    expect(f.complete).toBe(true);
    expect(f.seasons).toHaveLength(1);
    expect(f.grid).toHaveLength(3);
    expect(f.grid[0].seasons[0].strategyCents).toBeGreaterThan(f.grid[0].strategyCents);
    expect((await saveSeasons(a.actor, id, [{ ...SUMMER, id: "s1" }])).version).toBeNull();
    expect((await prop(id)).economicsVersion).toBe(1);
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, a.tenantId), eq(schema.auditEvents.entityId, id), eq(schema.auditEvents.type, "property.economics_versioned")));
    expect(ev).toHaveLength(1);
  });
  it("les autres valeurs du modèle sont conservées ; une liste vide retire les saisons", async () => {
    const id = await make(a, "Retrait");
    await saveSeasons(a.actor, id, [SUMMER]);
    const e = (await prop(id)).economics as EconomicModel;
    expect(e.cleaningCostCents).toBe(4000);
    expect(e.channels.AIRBNB?.commissionPct).toBe(15);
    expect((await saveSeasons(a.actor, id, [])).version).toBe(2);
    expect("seasons" in ((await prop(id)).economics as object)).toBe(false);
  });
  it("la validation des planchers devient périmée dès qu'une saison est ajoutée, et redevient valable si elle est retirée", async () => {
    const id = await make(a, "Validation", { onboarding: { step: "verification", completedAt: new Date().toISOString() } as never });
    await validateFloors(a.actor, id, floorFingerprint(ECON as unknown as EconomicModel)!, "ok");
    expect((await getValidations(a.tenantId, id)).floors.status).toBe("OK");
    await saveSeasons(a.actor, id, [SUMMER]);
    const v = await getValidations(a.tenantId, id);
    expect(v.floors.status).toBe("STALE");
    expect(v.grid[0].seasons).toHaveLength(1);
    await saveSeasons(a.actor, id, []);
    expect((await getValidations(a.tenantId, id)).floors.status).toBe("OK");
  });
  it("refuse : chevauchement, sous le seuil de dérangement, logement de démonstration, autre espace ; rien n'est écrit", async () => {
    const id = await make(a, "Refus");
    expect(await code(saveSeasons(a.actor, id, [SUMMER, { ...SUMMER, label: "Août", from: "08-15", to: "09-15" }]))).toMatch(/INVALID: Les saisons « Été » et « Août » se chevauchent/);
    expect(await code(saveSeasons(a.actor, id, [{ ...SUMMER, strategyContributionPerNightCents: 2000 }]))).toMatch(/INVALID: .*seuil de dérangement/);
    expect((await prop(id)).economicsVersion).toBe(0);
    const demo = await make(a, "Démo", { isDemo: true });
    expect(await code(saveSeasons(a.actor, demo, [SUMMER]))).toMatch(/INVALID: .*démonstration/);
    expect(await code(saveSeasons(b.actor, id, [SUMMER]))).toMatch(/NOT_FOUND/);
    expect(await code(getFloors(b.tenantId, id))).toMatch(/NOT_FOUND/);
  });
  it("modèle incomplet : la grille est vide et dit ce qui manque", async () => {
    const id = await make(a, "Incomplet", { economics: { ...ECON, cleaningCostCents: null } as never });
    const f = await getFloors(a.tenantId, id);
    expect(f.complete).toBe(false);
    expect(f.grid).toEqual([]);
    expect(f.missing).toContain("coût du ménage");
  });
  it("le parcours « Coûts et seuils » conserve les saisons, y compris pour un brouillon dont le seuil dépasse une saison", async () => {
    const id = await make(a, "Parcours", { status: "ACTIVE" });
    await saveSeasons(a.actor, id, [SUMMER]);
    (globalThis as any).__user = a.actor;
    const { saveCostsAction } = await import("@/app/actions/costs");
    const r = await saveCostsAction(id, { airbnbPct: "16" } as never, false);
    expect(r.error).toBeUndefined();
    expect(((await prop(id)).economics as EconomicModel).seasons).toHaveLength(1);
    const r2 = await saveCostsAction(id, { airbnbPct: "16", hardMode: "set", hard: "80" } as never, false);
    expect(r2.error).toBeUndefined(); // brouillon : enregistré, saisons conservées
    expect(((await prop(id)).economics as EconomicModel).seasons).toHaveLength(1);
  });
  it("renommer une saison est enregistré et versionné ; changer seulement l'ordre n'ajoute pas de version mais s'enregistre", async () => {
    const id = await make(a, "Renom");
    await saveSeasons(a.actor, id, [SUMMER, { label: "Fêtes", from: "12-20", to: "01-05", strategyContributionPerNightCents: 5000 }]);
    const [s1, s2] = ((await prop(id)).economics as EconomicModel).seasons!;
    expect([s1.id, s2.id]).toEqual(["s1", "s2"]);
    const r = await saveSeasons(a.actor, id, [{ ...s1, label: "Haute saison" }, s2]);
    expect(r.version).toBe(2);
    expect((await listEconomicsVersions(a.tenantId, id))[0].changes[0]).toMatchObject({ key: "seasons.s1", from: "« Été » 07-01 → 08-31 : 60,00 € par nuit", to: "« Haute saison » 07-01 → 08-31 : 60,00 € par nuit" });
    const r2 = await saveSeasons(a.actor, id, [s2, { ...s1, label: "Haute saison" }]);
    expect(r2.version).toBeNull();
    expect(((await prop(id)).economics as EconomicModel).seasons!.map((x) => x.id)).toEqual(["s2", "s1"]);
  });
  it("identifiants stables : retirer la première saison puis en ajouter une n'entre pas en collision", async () => {
    const id = await make(a, "Ids");
    await saveSeasons(a.actor, id, [SUMMER, { label: "Fêtes", from: "12-20", to: "01-05", strategyContributionPerNightCents: 5000 }]);
    const [, s2] = ((await prop(id)).economics as EconomicModel).seasons!;
    await saveSeasons(a.actor, id, [s2, { label: "Printemps", from: "04-01", to: "04-30", strategyContributionPerNightCents: 4500 }]);
    expect(((await prop(id)).economics as EconomicModel).seasons!.map((x) => x.id)).toEqual(["s2", "s1"]);
  });
  it("modèle incomplet : saisons refusées ; logement supprimé : introuvable", async () => {
    const id = await make(a, "Sans base", { economics: { ...ECON, cleaningCostCents: null } as never });
    expect(await code(saveSeasons(a.actor, id, [SUMMER]))).toMatch(/INVALID: Renseignez d'abord.*coût du ménage/);
    expect((await prop(id)).economicsVersion).toBe(0);
  });
});
