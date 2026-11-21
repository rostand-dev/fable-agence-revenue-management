import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { confirmMapping, getMapping } from "./mapping";
import { createProperty, PortfolioError } from "./portfolio";
import { activateProperty, getQuality } from "./quality";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
beforeAll(async () => { a = await makeTenant("A-qual"); b = await makeTenant("B-qual"); });
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof PortfolioError) return e.code + ": " + e.message; throw e; } throw new Error("aurait dû échouer"); };
const prop = (id: string) => db.select().from(schema.properties).where(eq(schema.properties.id, id)).then((r) => r[0]);
const events = (t: T) => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, "property.activated")));
const ECON = { cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 } } };

/** Logement en observation, complet : tout est vrai sauf ce que le test retire. */
async function shadow(t: T, name: string) {
  const { id } = await createProperty(t.actor, { name, city: "Lille", kind: "T2", bedrooms: 2 });
  await db.update(schema.properties).set({
    status: "SHADOW", economics: ECON as never, strategy: { basePriceCents: 12000, minPriceCents: 8000, maxPriceCents: 20000, minStay: 2 } as never,
    pricelabs: { apiKeyEnc: "x", listingId: "pl1", pms: "superhote", listingName: "Annonce", candidates: [{ id: "pl1", pms: "superhote", name: "Annonce", city: "Lille", bedrooms: 2 }], lastSync: { ok: true, at: new Date().toISOString(), days: 90 } } as never,
  }).where(eq(schema.properties.id, id));
  return id;
}
const confirm = async (t: T, id: string) => confirmMapping(t.actor, id, false, (await getMapping(t.tenantId, id)).fingerprint);

describe("checklist de qualité et activation (US-024)", () => {
  it("mapping non confirmé : activation refusée, rien n'est écrit", async () => {
    const id = await shadow(a, "Sans confirmation");
    const q = await getQuality(a.tenantId, id);
    expect(q.blockers).toEqual(["mapping"]);
    expect(await code(activateProperty(a.actor, id))).toMatch(/^INVALID: Activation refusée\. À corriger : Mapping des identifiants confirmé/);
    expect((await prop(id)).status).toBe("SHADOW");
    expect((await events(a)).filter((e) => e.entityId === id)).toHaveLength(0);
  });
  it("checklist satisfaite : activation tracée avec le détail de la checklist, non rejouable", async () => {
    const id = await shadow(a, "Complet");
    await confirm(a, id);
    expect((await getQuality(a.tenantId, id)).canActivate).toBe(true);
    await activateProperty(a.actor, id);
    expect((await prop(id)).status).toBe("ACTIVE");
    const ev = (await events(a)).filter((e) => e.entityId === id);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ warnings: ["superhote"] });
    expect(await code(activateProperty(a.actor, id))).toMatch(/^INVALID: Ce logement est déjà actif/);
    expect((await events(a)).filter((e) => e.entityId === id)).toHaveLength(1);
  });
  it("le contrôle est refait au moment d'activer : un mapping périmé ou des prix incohérents bloquent", async () => {
    const id = await shadow(a, "Périmé");
    await confirm(a, id);
    await db.update(schema.properties).set({ strategy: { basePriceCents: 12000, minPriceCents: 15000, maxPriceCents: 20000 } as never }).where(eq(schema.properties.id, id));
    expect(await code(activateProperty(a.actor, id))).toMatch(/Prix de base et minimum cohérents/);
    await db.update(schema.properties).set({ strategy: { basePriceCents: 12000, minPriceCents: 8000, maxPriceCents: 20000 } as never, pricelabs: { apiKeyEnc: "x", listingId: "pl2", pms: "superhote", listingName: "Autre", candidates: [], lastSync: { ok: true, at: new Date().toISOString(), days: 90 } } as never }).where(eq(schema.properties.id, id));
    expect((await getMapping(a.tenantId, id)).status).toBe("STALE");
    expect(await code(activateProperty(a.actor, id))).toMatch(/Mapping des identifiants/);
    expect((await prop(id)).status).toBe("SHADOW");
  });
  it("grille jamais lue ou coûts manquants : bloqué", async () => {
    const id = await shadow(a, "Sans grille");
    await confirm(a, id);
    await db.update(schema.properties).set({ economics: {} as never }).where(eq(schema.properties.id, id));
    const q = await getQuality(a.tenantId, id);
    expect(q.blockers).toEqual(["economics"]);
    await db.update(schema.properties).set({ economics: ECON as never, pricelabs: { apiKeyEnc: "x", listingId: "pl1", pms: "superhote", listingName: "Annonce", candidates: [{ id: "pl1", pms: "superhote", name: "Annonce", city: "Lille", bedrooms: 2 }] } as never }).where(eq(schema.properties.id, id));
    expect((await getQuality(a.tenantId, id)).blockers).toEqual(["calendar"]);
  });
  it("statuts refusés : en création, démonstration ; autre espace : introuvable et intouché", async () => {
    const { id: onb } = await createProperty(a.actor, { name: "En création", city: "Lille", kind: "T2" });
    expect(await code(activateProperty(a.actor, onb))).toMatch(/^INVALID: Seul un logement en observation/);
    const demo = await shadow(a, "Démo");
    await db.update(schema.properties).set({ isDemo: true }).where(eq(schema.properties.id, demo));
    expect(await code(activateProperty(a.actor, demo))).toMatch(/démonstration/);
    const id = await shadow(a, "Autre espace");
    await confirm(a, id);
    expect(await code(activateProperty(b.actor, id))).toMatch(/^NOT_FOUND/);
    expect(await code(getQuality(b.tenantId, id) as Promise<unknown>)).toMatch(/^NOT_FOUND/);
    expect((await prop(id)).status).toBe("SHADOW");
  });
  it("deux activations simultanées : une seule réussit, un seul événement", async () => {
    const id = await shadow(a, "Concurrence");
    await confirm(a, id);
    const r = await Promise.allSettled([activateProperty(a.actor, id), activateProperty(a.actor, id)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect((await events(a)).filter((e) => e.entityId === id)).toHaveLength(1);
  });
  it("grille périmée ou dernière lecture en échec : bloqué, avec un détail distinct", async () => {
    const id = await shadow(a, "Grille périmée");
    await confirm(a, id);
    const pl = (await prop(id)).pricelabs as Record<string, unknown>;
    await db.update(schema.properties).set({ pricelabs: { ...pl, lastSync: { ok: true, at: "2020-01-01T00:00:00.000Z", days: 90 } } as never }).where(eq(schema.properties.id, id));
    expect((await getQuality(a.tenantId, id)).items.find((i) => i.key === "calendar")?.detail).toMatch(/plus de 48 h/);
    await db.update(schema.properties).set({ pricelabs: { ...pl, lastSync: { ok: false, at: new Date().toISOString(), error: "x" } } as never }).where(eq(schema.properties.id, id));
    expect((await getQuality(a.tenantId, id)).items.find((i) => i.key === "calendar")?.detail).toMatch(/a échoué/);
    expect(await code(activateProperty(a.actor, id))).toMatch(/Grille de prix lue/);
  });
});
