import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { confirmMapping, getMapping } from "./mapping";
import { createListing, createProperty, PortfolioError } from "./portfolio";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
beforeAll(async () => { a = await makeTenant("A-map"); b = await makeTenant("B-map"); });

const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof PortfolioError) return e.code + ": " + e.message; throw e; } throw new Error("aurait dû échouer"); };
const link = (id: string, city: string) => db.update(schema.properties).set({ pricelabs: { apiKeyEnc: "x", listingId: "pl1", pms: "superhote", listingName: "Annonce", candidates: [{ id: "pl1", pms: "superhote", name: "Annonce", city, bedrooms: 2 }] } }).where(eq(schema.properties.id, id));
const confirm = async (t: T, id: string, ack: boolean) => confirmMapping(t.actor, id, ack, (await getMapping(t.tenantId, id)).fingerprint);
const events = (t: T) => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, "mapping.confirmed")));

describe("mapping des identifiants (US-021)", () => {
  it("sans PriceLabs : incomplet, la confirmation est refusée", async () => {
    const { id } = await createProperty(a.actor, { name: "Sans PL", city: "Lille", kind: "T2" });
    expect(await getMapping(a.tenantId, id)).toMatchObject({ status: "INCOMPLETE", confirmable: false });
    expect(await code(confirm(a, id, true))).toMatch(/^INVALID: Rattachez d'abord/);
  });
  it("confirmation sans écart : tracée, rejouable sans doublon, périmée dès qu'une annonce est ajoutée", async () => {
    const { id } = await createProperty(a.actor, { name: "Sans écart", city: "Lille", kind: "T2", bedrooms: 2 });
    await link(id, "Lille");
    expect((await getMapping(a.tenantId, id)).status).toBe("TO_CONFIRM");
    await confirm(a, id, false);
    await confirm(a, id, false);
    expect((await getMapping(a.tenantId, id)).status).toBe("CONFIRMED");
    expect((await events(a)).filter((e) => e.entityId === id)).toHaveLength(1);
    await createListing(a.actor, id, { channel: "AIRBNB", externalId: "12345678" });
    expect((await getMapping(a.tenantId, id)).status).toBe("STALE");
    await confirm(a, id, false);
    expect((await getMapping(a.tenantId, id)).status).toBe("CONFIRMED");
  });
  it("écart détecté : refusé sans accusé de lecture, accepté avec, les écarts sont gardés dans le journal", async () => {
    const { id } = await createProperty(a.actor, { name: "Avec écart", city: "Lille", kind: "T2", bedrooms: 2 });
    await link(id, "Lyon");
    const m = await getMapping(a.tenantId, id);
    expect(m.checks.map((c) => c.id)).toEqual(["pl-city"]);
    expect(await code(confirm(a, id, false))).toMatch(/^INVALID: Des écarts sont signalés/);
    await confirm(a, id, true);
    await confirm(a, id, false); // rejeu sur un mapping déjà confirmé : sans effet, pas d'erreur
    const ev = (await events(a)).find((e) => e.entityId === id)!;
    expect(ev.summary).toContain("malgré 1 écart");
    expect((ev.payload as any).warnings[0]).toContain("Lyon");
  });
  it("on confirme ce qu'on a vu : une empreinte absente ou périmée est refusée", async () => {
    const { id } = await createProperty(a.actor, { name: "Empreinte", city: "Lille", kind: "T2", bedrooms: 2 });
    await link(id, "Lille");
    const seen = (await getMapping(a.tenantId, id)).fingerprint;
    expect(await code(confirmMapping(a.actor, id, false, undefined))).toMatch(/^CONFLICT/);
    await createListing(a.actor, id, { channel: "AIRBNB", externalId: "87654321" }); // quelqu'un change un identifiant entre l'affichage et le clic
    expect(await code(confirmMapping(a.actor, id, false, seen))).toMatch(/^CONFLICT: Les rattachements ont changé/);
    expect((await getMapping(a.tenantId, id)).status).toBe("TO_CONFIRM");
  });
  it("changer la ville ou les chambres du logement périme la confirmation", async () => {
    const { id } = await createProperty(a.actor, { name: "Ville change", city: "Lille", kind: "T2", bedrooms: 2 });
    await link(id, "Lille");
    await confirm(a, id, false);
    expect((await getMapping(a.tenantId, id)).status).toBe("CONFIRMED");
    await db.update(schema.properties).set({ city: "Lyon" }).where(eq(schema.properties.id, id));
    const m = await getMapping(a.tenantId, id);
    expect(m.status).toBe("STALE");
    expect(m.checks.map((c) => c.id)).toEqual(["pl-city"]);
  });
  it("changer le logement PriceLabs ou SuperHote rattaché périme la confirmation", async () => {
    const { id } = await createProperty(a.actor, { name: "Autre annonce", city: "Lille", kind: "T2", bedrooms: 2 });
    await link(id, "Lille");
    await confirm(a, id, false);
    await db.update(schema.properties).set({ superhote: { apiKeyEnc: "x", rentalId: "r1", rentalName: "T2", candidates: [{ id: "r1", name: "T2", city: "Lille", capacity: 4 }] } }).where(eq(schema.properties.id, id));
    expect((await getMapping(a.tenantId, id)).status).toBe("STALE");
  });
  it("deux confirmations simultanées ne laissent qu'un seul événement", async () => {
    const { id } = await createProperty(a.actor, { name: "Course", city: "Lille", kind: "T2", bedrooms: 2 });
    await link(id, "Lille");
    const fp = (await getMapping(a.tenantId, id)).fingerprint;
    await Promise.all([confirmMapping(a.actor, id, false, fp), confirmMapping(a.actor, id, false, fp)]);
    expect((await events(a)).filter((e) => e.entityId === id)).toHaveLength(1);
  });
  it("un logement de démonstration ne se confirme pas", async () => {
    const [demo] = await db.insert(schema.properties).values({ id: "prop_demo_map_" + Date.now(), tenantId: a.tenantId, name: "Démo", city: "Paris", kind: "T2", status: "ACTIVE", isDemo: true, pricelabs: { listingId: "x", candidates: [] } }).returning();
    expect(await code(confirmMapping(a.actor, demo.id, true, "x"))).toMatch(/^INVALID: Un logement de démonstration/);
  });
  it("cloisonnement : le mapping d'un autre espace est introuvable et intouchable", async () => {
    const { id } = await createProperty(b.actor, { name: "Chez B", city: "Nice", kind: "T2" });
    expect(await code(getMapping(a.tenantId, id))).toMatch(/^NOT_FOUND/);
    expect(await code(confirm(a, id, true))).toMatch(/^NOT_FOUND/);
  });
  it("les annonces archivées ne comptent pas dans le mapping", async () => {
    const { id } = await createProperty(a.actor, { name: "Archivée", city: "Lille", kind: "T2" });
    const lid = await createListing(a.actor, id, { channel: "BOOKING", externalId: "7654321" });
    await db.update(schema.listings).set({ status: "ARCHIVED" }).where(eq(schema.listings.id, lid));
    expect((await getMapping(a.tenantId, id)).items.find((i) => i.key === "booking")!.state).toBe("missing");
  });
});
describe("migration 0015 (colonne mapping)", () => {
  it("se rejoue sans erreur", async () => {
    const st = fs.readFileSync(path.join(process.cwd(), "drizzle", "0015_property_mapping.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
    for (let i = 0; i < 2; i++) for (const s of st) await db.execute(sql.raw(s));
  });
});
