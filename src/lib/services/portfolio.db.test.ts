import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { withTenant } from "@/db/tenant";
import { makeProperty, makeTenant } from "@/test/db";
import { createListing, createOwner, createProperty, deleteListing, deleteOwner, deleteProperty, ensureDefaultOwner, listListings, listOwners, PortfolioError, renameTenant, setListingStatus, updateListing, updateOwner, updatePropertyIdentity } from "./portfolio";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
beforeAll(async () => { a = await makeTenant("A-pf"); b = await makeTenant("B-pf"); });

const audit = (t: T, type: string) => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, type)));
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof PortfolioError) return e.code + ": " + e.message; throw e; } throw new Error("aurait dû échouer"); };

describe("propriétaires (US-020)", () => {
  it("l'espace reçoit un propriétaire par défaut, créé une seule fois (rejouable)", async () => {
    const id1 = await ensureDefaultOwner(db, a.tenantId), id2 = await ensureDefaultOwner(db, a.tenantId);
    expect(id2).toBe(id1);
    const rows = await db.select().from(schema.owners).where(eq(schema.owners.tenantId, a.tenantId));
    expect(rows.filter((o) => o.isDefault)).toHaveLength(1);
    expect(rows[0].name).toBe("Espace A-pf");
  });
  it("création, lecture, modification, suppression, avec audit", async () => {
    const id = await createOwner(a.actor, { name: "SCI Les Lilas", email: "Contact@Lilas.fr", notes: "Mandat 2026" });
    let o = (await listOwners(a.tenantId)).find((x) => x.id === id)!;
    expect(o).toMatchObject({ name: "SCI Les Lilas", email: "contact@lilas.fr", isDefault: false, propertyCount: 0 });
    await updateOwner(a.actor, id, { name: "SCI Les Lilas 2", email: "", notes: "" });
    o = (await listOwners(a.tenantId)).find((x) => x.id === id)!;
    expect(o).toMatchObject({ name: "SCI Les Lilas 2", email: null, notes: null });
    await deleteOwner(a.actor, id);
    expect((await listOwners(a.tenantId)).some((x) => x.id === id)).toBe(false);
    expect((await audit(a, "owner.created")).length).toBeGreaterThanOrEqual(1);
    expect((await audit(a, "owner.updated")).length).toBeGreaterThanOrEqual(1);
    expect((await audit(a, "owner.deleted")).length).toBeGreaterThanOrEqual(1);
  });
  it("un nom en double (sans tenir compte des majuscules) est refusé ; une modification sans changement n'écrit rien au journal", async () => {
    const id = await createOwner(a.actor, { name: "Doublon Test" });
    expect(await code(createOwner(a.actor, { name: "doublon test" }))).toMatch(/^CONFLICT/);
    const before = (await audit(a, "owner.updated")).length;
    await updateOwner(a.actor, id, { name: "Doublon Test" });
    expect((await audit(a, "owner.updated")).length).toBe(before);
    expect(await code(updateOwner(a.actor, id, { name: "x" }))).toMatch(/^INVALID/);
  });
  it("le propriétaire par défaut et celui qui possède des logements ne se suppriment pas", async () => {
    const def = await ensureDefaultOwner(db, a.tenantId);
    expect(await code(deleteOwner(a.actor, def))).toMatch(/^CONFLICT: Le propriétaire par défaut/);
    const id = await createOwner(a.actor, { name: "Avec logement" });
    const c = await createProperty(a.actor, { name: "Bien lié", city: "Lyon", kind: "T2", ownerId: id });
    expect(await code(deleteOwner(a.actor, id))).toMatch(/^CONFLICT: 1 logement lui est rattaché/);
    await deleteProperty(a.actor, c.id, "Bien lié");
    await deleteOwner(a.actor, id);
  });
  it("cloisonnement : on ne lit, ne modifie ni ne supprime le propriétaire d'un autre espace", async () => {
    const idB = await createOwner(b.actor, { name: "Propriétaire de B" });
    expect((await listOwners(a.tenantId)).some((o) => o.id === idB)).toBe(false);
    expect(await code(updateOwner(a.actor, idB, { name: "Piraté" }))).toMatch(/^NOT_FOUND/);
    expect(await code(deleteOwner(a.actor, idB))).toMatch(/^NOT_FOUND/);
    expect((await db.select().from(schema.owners).where(eq(schema.owners.id, idB)))[0].name).toBe("Propriétaire de B");
  });
});

describe("logements (US-020)", () => {
  it("création : dossier ONBOARDING, tout inconnu, propriétaire par défaut, audit", async () => {
    const c = await createProperty(a.actor, { name: " Studio Montmartre ", city: "Paris", kind: "Studio", bedrooms: "", capacity: 2 });
    const [p] = await db.select().from(schema.properties).where(eq(schema.properties.id, c.id));
    expect(p).toMatchObject({ name: "Studio Montmartre", status: "ONBOARDING", isDemo: false, bedrooms: null, capacity: 2, ownerId: await ensureDefaultOwner(db, a.tenantId) });
    expect((p.economics as any).channels).toEqual({});
    expect((p.economics as any).cleaningCostCents).toBeNull();
    expect((await audit(a, "property.created")).some((e) => e.entityId === c.id)).toBe(true);
  });
  it("création : propriétaire d'un autre espace refusé, identité incomplète refusée", async () => {
    const idB = await createOwner(b.actor, { name: "Autre espace" });
    expect(await code(createProperty(a.actor, { name: "Intrus", city: "Paris", kind: "T1", ownerId: idB }))).toMatch(/^INVALID: Ce propriétaire n'existe pas/);
    expect(await code(createProperty(a.actor, { name: "Intrus", city: "", kind: "T1" }))).toMatch(/^INVALID/);
    const n = await db.select().from(schema.properties).where(and(eq(schema.properties.tenantId, a.tenantId), eq(schema.properties.name, "Intrus")));
    expect(n).toHaveLength(0);
  });
  it("modification d'identité et changement de propriétaire, tracés", async () => {
    const c = await createProperty(a.actor, { name: "Maison Évry", city: "Évry", kind: "T5" });
    const o = await createOwner(a.actor, { name: "Nouveau proprio" });
    await updatePropertyIdentity(a.actor, c.id, { city: "Évry-Courcouronnes", capacity: 8, ownerId: o });
    const [p] = await db.select().from(schema.properties).where(eq(schema.properties.id, c.id));
    expect(p).toMatchObject({ city: "Évry-Courcouronnes", capacity: 8, ownerId: o, name: "Maison Évry" });
    const ev = (await audit(a, "property.updated")).find((e) => e.entityId === c.id)!;
    expect((ev.payload as any).changed.sort()).toEqual(["capacity", "city", "ownerId"]);
    expect(await code(updatePropertyIdentity(a.actor, c.id, { name: "" }))).toMatch(/^INVALID/);
    expect(await code(updatePropertyIdentity(b.actor, c.id, { city: "Hack" }))).toMatch(/^NOT_FOUND/);
  });
  it("un logement de démonstration ne se modifie ni ne se supprime", async () => {
    const id = newId("prop");
    await db.insert(schema.properties).values({ id, tenantId: a.tenantId, name: "Démo", city: "Paris", kind: "T2", status: "ACTIVE", isDemo: true });
    expect(await code(updatePropertyIdentity(a.actor, id, { city: "Lyon" }))).toMatch(/démonstration/);
    expect(await code(deleteProperty(a.actor, id, "Démo"))).toMatch(/démonstration/);
    expect(await code(createListing(a.actor, id, { channel: "DIRECT" }))).toMatch(/démonstration/);
  });
  it("suppression : le nom exact est exigé, tout part avec le logement, le journal reste", async () => {
    const c = await createProperty(a.actor, { name: "À supprimer", city: "Nice", kind: "T2" });
    await db.insert(schema.reservations).values({ id: newId("res"), tenantId: a.tenantId, propertyId: c.id, externalId: "r1", channel: "AIRBNB", checkIn: "2026-12-01", checkOut: "2026-12-03", nights: 2, grossRoomCents: 20000, bookedAt: "2026-11-01" });
    await createListing(a.actor, c.id, { channel: "AIRBNB", externalId: "12345678" });
    expect(await code(deleteProperty(a.actor, c.id, "autre nom"))).toMatch(/^INVALID: Pour confirmer/);
    expect(await code(deleteProperty(a.actor, c.id, undefined))).toMatch(/^INVALID/);
    expect(await code(deleteProperty(b.actor, c.id, "À supprimer"))).toMatch(/^NOT_FOUND/);
    await deleteProperty(a.actor, c.id, " À supprimer ");
    expect(await db.select().from(schema.properties).where(eq(schema.properties.id, c.id))).toHaveLength(0);
    expect(await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, c.id))).toHaveLength(0);
    expect(await db.select().from(schema.listings).where(eq(schema.listings.propertyId, c.id))).toHaveLength(0);
    const ev = (await audit(a, "property.deleted")).find((e) => e.entityId === c.id)!;
    expect(ev.payload).toMatchObject({ name: "À supprimer", reservations: 1, listings: 1, opportunities: 0 });
  });
  it("suppression refusée tant qu'une action de revenu est en cours", async () => {
    const pid = await makeProperty(a.tenantId, "Avec action");
    const oid = newId("opp");
    await db.insert(schema.opportunities).values({ id: oid, tenantId: a.tenantId, propertyId: pid, code: "OPP-" + oid, playbook: "PB-01", reasonCode: "X", title: "t", stayFrom: "2026-12-01", stayTo: "2026-12-05", dedupeKey: "k" + oid, signals: {}, diagnosis: {}, candidates: [], expiresAt: "2026-12-31" });
    const aid = newId("act");
    await db.insert(schema.revenueActions).values({ id: aid, tenantId: a.tenantId, propertyId: pid, opportunityId: oid, type: "MIN_STAY_OVERRIDE", label: "l", target: {}, parameters: {}, simulation: {}, audit: {}, status: "EXECUTED", riskLevel: "LOW", rollbackPlan: "r", idempotencyKey: "idem" + aid });
    expect(await code(deleteProperty(a.actor, pid, "Avec action"))).toMatch(/^CONFLICT: 1 action de revenu est en cours/);
    await db.update(schema.revenueActions).set({ status: "REJECTED" }).where(eq(schema.revenueActions.id, aid));
    await deleteProperty(a.actor, pid, "Avec action");
  });
});

describe("annonces (US-020)", () => {
  let pid = "", pidB = "";
  beforeAll(async () => { pid = (await createProperty(a.actor, { name: "Annonces A", city: "Lille", kind: "T2" })).id; pidB = (await createProperty(a.actor, { name: "Annonces A2", city: "Lille", kind: "T3" })).id; });
  it("création, lecture, modification, archivage, rétablissement et suppression, avec audit", async () => {
    const id = await createListing(a.actor, pid, { channel: "BOOKING", externalId: "1234567", title: "Appart Lille" });
    expect((await listListings(a.tenantId, pid)).find((l) => l.id === id)).toMatchObject({ channel: "BOOKING", externalId: "1234567", status: "ACTIVE", title: "Appart Lille" });
    await updateListing(a.actor, pid, id, { title: "Nouveau titre", url: "https://www.booking.com/hotel/fr/x.html" });
    expect((await listListings(a.tenantId, pid)).find((l) => l.id === id)).toMatchObject({ title: "Nouveau titre", externalId: "1234567", url: "https://www.booking.com/hotel/fr/x.html" });
    await setListingStatus(a.actor, pid, id, "ARCHIVED");
    expect((await listListings(a.tenantId, pid))[0].status).toBe("ARCHIVED");
    await setListingStatus(a.actor, pid, id, "ACTIVE");
    await deleteListing(a.actor, pid, id);
    expect(await listListings(a.tenantId, pid)).toHaveLength(0);
    for (const t of ["listing.created", "listing.updated", "listing.archived", "listing.restored", "listing.deleted"]) expect((await audit(a, t)).length, t).toBeGreaterThanOrEqual(1);
  });
  it("Airbnb : l'identifiant est déduit de l'adresse", async () => {
    const id = await createListing(a.actor, pid, { channel: "AIRBNB", url: "https://www.airbnb.fr/rooms/55555555" });
    expect((await listListings(a.tenantId, pid)).find((l) => l.id === id)!.externalId).toBe("55555555");
    await deleteListing(a.actor, pid, id);
  });
  it("un identifiant déjà rattaché à un autre logement de l'espace est refusé, en nommant ce logement", async () => {
    const id = await createListing(a.actor, pid, { channel: "AIRBNB", externalId: "77777777" });
    const msg = await code(createListing(a.actor, pidB, { channel: "AIRBNB", externalId: "77777777" }));
    expect(msg).toMatch(/^CONFLICT: .*déjà rattaché à votre logement « Annonces A »/);
    expect(await code(updateListing(a.actor, pidB, await createListing(a.actor, pidB, { channel: "AIRBNB" }), { externalId: "77777777" }))).toMatch(/^CONFLICT: .*« Annonces A »/);
    await db.delete(schema.listings).where(eq(schema.listings.propertyId, pidB));
    await deleteListing(a.actor, pid, id);
  });
  it("une seule annonce active par canal Airbnb ou Booking ; une archivée libère la place, le rétablissement la reprend", async () => {
    const first = await createListing(a.actor, pid, { channel: "BOOKING" });
    expect(await code(createListing(a.actor, pid, { channel: "BOOKING" }))).toMatch(/^CONFLICT: .*déjà une annonce active/);
    await setListingStatus(a.actor, pid, first, "ARCHIVED");
    const second = await createListing(a.actor, pid, { channel: "BOOKING" });
    expect(await code(setListingStatus(a.actor, pid, first, "ACTIVE"))).toMatch(/^CONFLICT: .*déjà une annonce active/);
    await createListing(a.actor, pid, { channel: "DIRECT" });
    await createListing(a.actor, pid, { channel: "DIRECT" }); // le canal direct n'est pas limité
    await db.delete(schema.listings).where(eq(schema.listings.propertyId, pid));
    expect(second).toBeTruthy();
  });
  it("le canal d'une annonce ne change pas ; une annonce d'un autre espace est introuvable", async () => {
    const id = await createListing(a.actor, pid, { channel: "DIRECT", title: "Site" });
    await updateListing(a.actor, pid, id, { channel: "AIRBNB", title: "Site 2" });
    expect((await listListings(a.tenantId, pid))[0]).toMatchObject({ channel: "DIRECT", title: "Site 2" });
    expect(await code(updateListing(b.actor, pid, id, { title: "Piraté" }))).toMatch(/^NOT_FOUND/);
    expect(await code(deleteListing(b.actor, pid, id))).toMatch(/^NOT_FOUND/);
    expect(await code(listListings(b.tenantId, pid))).toMatch(/^NOT_FOUND/);
    await db.delete(schema.listings).where(eq(schema.listings.propertyId, pid));
  });
});

describe("espace (US-020)", () => {
  it("renommage tracé ; un nom identique n'écrit rien", async () => {
    await renameTenant(b.actor, "Nouveau nom B");
    expect((await db.select().from(schema.tenants).where(eq(schema.tenants.id, b.tenantId)))[0].name).toBe("Nouveau nom B");
    const n = (await audit(b, "tenant.renamed")).length;
    await renameTenant(b.actor, "Nouveau nom B");
    expect((await audit(b, "tenant.renamed")).length).toBe(n);
    expect(await code(renameTenant(b.actor, "x"))).toMatch(/^INVALID/);
  });
});

describe("isolation par la base (RLS) sur les nouvelles tables", () => {
  it("sous le rôle d'un espace, les propriétaires et annonces des autres sont invisibles et intouchables", async () => {
    const pid = (await createProperty(b.actor, { name: "RLS B", city: "Lyon", kind: "T1" })).id;
    const lid = await createListing(b.actor, pid, { channel: "DIRECT" });
    const seen = await withTenant(a.tenantId, (tx) => tx.select({ id: schema.listings.id }).from(schema.listings), { enforce: true });
    expect(seen.some((l) => l.id === lid)).toBe(false);
    const own = await withTenant(a.tenantId, (tx) => tx.select({ t: schema.owners.tenantId }).from(schema.owners), { enforce: true });
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((o) => o.t === a.tenantId)).toBe(true);
    const del = await withTenant(a.tenantId, (tx) => tx.delete(schema.listings).returning({ id: schema.listings.id }), { enforce: true });
    expect(del.some((l) => l.id === lid)).toBe(false);
    await expect(withTenant(a.tenantId, (tx) => tx.insert(schema.owners).values({ id: newId("own"), tenantId: b.tenantId, name: "Intrus" }), { enforce: true })).rejects.toThrow();
  });
});

describe("reprise des espaces existants (migration 0014)", () => {
  const statements = fs.readFileSync(path.join(process.cwd(), "drizzle", "0014_owners_listings.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean).slice(-2);
  it("rattache un logement sans propriétaire au propriétaire par défaut créé pour son espace, sans doublon au second passage", async () => {
    const t = await makeTenant("C-reprise");
    const pid = newId("prop");
    await db.insert(schema.properties).values({ id: pid, tenantId: t.tenantId, name: "Ancien logement", city: "Paris", kind: "T2", status: "ACTIVE" });
    for (let pass = 1; pass <= 2; pass++) for (const st of statements) await db.execute(sql.raw(st));
    const owners = await db.select().from(schema.owners).where(eq(schema.owners.tenantId, t.tenantId));
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ isDefault: true, name: "Espace C-reprise" });
    expect((await db.select().from(schema.properties).where(eq(schema.properties.id, pid)))[0].ownerId).toBe(owners[0].id);
  });
});
