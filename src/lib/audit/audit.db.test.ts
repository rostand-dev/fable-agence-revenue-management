import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { failure } from "@/test/errors";
import { makeProperty, makeTenant } from "@/test/db";
import { recordAudit } from "./log";
import { auditTrail, listAuditEvents, propertyAuditTrail } from "./query";

const ev = (tenantId: string, over: Partial<Parameters<typeof recordAudit>[1]> = {}) =>
  recordAudit(db, { tenantId, actor: "user:u", type: "action.approved", entity: "RevenueAction", entityId: "act_1", summary: "Test", ...over });

describe("journal en ajout seul, porté par la base", () => {
  it("accepte l'ajout", async () => {
    const { tenantId } = await makeTenant();
    const id = await ev(tenantId);
    const [row] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, id));
    expect(row.tenantId).toBe(tenantId);
  });

  it("refuse toute modification, même d'un rôle qui contourne tout (superutilisateur de test)", async () => {
    const { tenantId } = await makeTenant();
    const id = await ev(tenantId);
    expect(await failure(db.update(schema.auditEvents).set({ summary: "falsifié" }).where(eq(schema.auditEvents.id, id)))).toMatch(/ajout seul/);
    expect(await failure(db.execute(sql`UPDATE audit_events SET tenant_id = 'autre' WHERE id = ${id}`))).toMatch(/ajout seul/);
    const [row] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, id));
    expect(row.summary).toBe("Test");
  });

  it("refuse toute suppression, y compris en masse et par troncature", async () => {
    const { tenantId } = await makeTenant();
    const id = await ev(tenantId);
    expect(await failure(db.delete(schema.auditEvents).where(eq(schema.auditEvents.id, id)))).toMatch(/ajout seul/);
    expect(await failure(db.delete(schema.auditEvents))).toMatch(/ajout seul/);
    expect(await failure(db.execute(sql`TRUNCATE audit_events`))).toMatch(/ajout seul/);
    expect((await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, id))).length).toBe(1);
  });

  it("supprimer un espace n'efface pas son journal (aucune cascade)", async () => {
    const { tenantId } = await makeTenant();
    await ev(tenantId);
    await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId));
    expect((await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.tenantId, tenantId))).length).toBe(1);
  });
});

describe("recordAudit", () => {
  it("écrit dans la transaction de l'appelant : tout réussit ou tout échoue ensemble", async () => {
    const { tenantId } = await makeTenant();
    const id = newId("evt");
    await expect(db.transaction(async (tx) => {
      await recordAudit(tx, { tenantId, actor: "system", type: "review.completed", entity: "ReviewRun", entityId: id, summary: "Dans la transaction" });
      throw new Error("échec après l'écriture de l'audit");
    })).rejects.toThrow();
    expect((await listAuditEvents(tenantId)).events).toHaveLength(0);
    await db.transaction(async (tx) => { await recordAudit(tx, { tenantId, actor: "system", type: "review.completed", entity: "ReviewRun", entityId: id, summary: "Validée" }); });
    expect((await listAuditEvents(tenantId)).events).toHaveLength(1);
  });

  it("masque les secrets du détail avant de l'écrire", async () => {
    const { tenantId } = await makeTenant();
    await ev(tenantId, { type: "llm.key_saved", payload: { apiKey: "sk-ant-secret", keyHint: "…abcd", nested: { token: "t" } } });
    const [e] = (await listAuditEvents(tenantId)).events;
    expect(JSON.stringify(e.payload)).not.toContain("sk-ant-secret");
    expect((e.payload as any).keyHint).toBe("…abcd");
  });

  it("refuse en test un type d'événement qui n'est pas au catalogue", async () => {
    const { tenantId } = await makeTenant();
    await expect(ev(tenantId, { type: "inconnu.type" as never })).rejects.toThrow(/type d'événement inconnu/);
  });
});

describe("lecture paginée du journal", () => {
  it("parcourt tout, sans doublon ni trou, même quand des événements partagent le même instant", async () => {
    const { tenantId } = await makeTenant();
    const same = new Date("2026-03-01T10:00:00.123Z");
    for (let i = 0; i < 12; i++) await ev(tenantId, { at: same, summary: "même instant " + i });
    for (let i = 0; i < 13; i++) await ev(tenantId, { at: new Date(+same + (i + 1) * 1000), summary: "plus tard " + i });
    const seen: string[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const page = await listAuditEvents(tenantId, { limit: 7, cursor });
      seen.push(...page.events.map((e) => e.id)); cursor = page.nextCursor; pages++;
    } while (cursor && pages < 20);
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(4);
    const all = (await listAuditEvents(tenantId, { limit: 200 })).events;
    expect(all.map((e) => e.id)).toEqual(seen);
    for (let i = 1; i < all.length; i++) expect(+all[i - 1].createdAt >= +all[i].createdAt).toBe(true);
  });

  it("conserve la précision de la base (microsecondes) dans le curseur", async () => {
    const { tenantId } = await makeTenant();
    // deux événements dans la même milliseconde, à la microseconde près : un curseur arrondi à la milliseconde en perdrait un
    for (const [i, us] of ["100100", "100900", "100500"].entries()) {
      await db.execute(sql`INSERT INTO audit_events (id, tenant_id, actor, type, entity, entity_id, summary, created_at) VALUES (${"evt_us" + i + tenantId}, ${tenantId}, 'system', 'review.completed', 'ReviewRun', 'r', 'µs', ${"2026-03-02T10:00:00." + us}::timestamptz)`);
    }
    const seen: string[] = []; let cursor: string | null = null;
    do { const p = await listAuditEvents(tenantId, { limit: 1, cursor }); seen.push(...p.events.map((e) => e.id)); cursor = p.nextCursor; } while (cursor);
    expect(seen).toHaveLength(3);
    expect(seen).toEqual(["evt_us1" + tenantId, "evt_us2" + tenantId, "evt_us0" + tenantId]);
  });

  it("filtre par famille et par objet", async () => {
    const { tenantId } = await makeTenant();
    await ev(tenantId, { type: "action.approved", entityId: "act_A" });
    await ev(tenantId, { type: "action.executed", entityId: "act_A" });
    await ev(tenantId, { type: "integration.kill_switch_on", entity: "Integration", entityId: "pricelabs" });
    expect((await listAuditEvents(tenantId, { category: "APPROVAL" })).events.map((e) => e.type)).toEqual(["action.approved"]);
    expect((await listAuditEvents(tenantId, { category: "INTEGRATION" })).events).toHaveLength(1);
    expect((await auditTrail(tenantId, "RevenueAction", "act_A")).map((e) => e.type)).toEqual(["action.approved", "action.executed"]);
  });

  it("ne montre jamais le journal d'un autre propriétaire", async () => {
    const a = await makeTenant("a"), b = await makeTenant("b");
    await ev(a.tenantId, { summary: "secret de A" });
    await ev(b.tenantId, { summary: "secret de B" });
    const seenByB = (await listAuditEvents(b.tenantId, { limit: 200 })).events;
    expect(seenByB.map((e) => e.summary)).toEqual(["secret de B"]);
    expect(await auditTrail(b.tenantId, "RevenueAction", "act_1")).toHaveLength(1);
    // un curseur fabriqué ne permet pas non plus de franchir la frontière
    const page = await listAuditEvents(a.tenantId, { limit: 1 });
    const stolen = await listAuditEvents(b.tenantId, { limit: 50, cursor: page.nextCursor });
    expect(stolen.events.every((e) => e.tenantId === b.tenantId)).toBe(true);
  });
});

describe("filtres du journal : période et auteur (US-085)", () => {
  const at = (tenantId: string, createdAt: string, actor: string, summary: string) =>
    db.insert(schema.auditEvents).values({ id: newId("evt"), tenantId, actor, type: "action.approved", entity: "RevenueAction", entityId: "act_x", summary, createdAt: new Date(createdAt) });
  it("la période est en jours UTC inclusifs, bornes comprises", async () => {
    const { tenantId } = await makeTenant();
    await at(tenantId, "2026-03-09T23:59:59Z", "user:u", "veille");
    await at(tenantId, "2026-03-10T00:00:00Z", "user:u", "premier instant");
    await at(tenantId, "2026-03-10T23:59:59Z", "user:u", "dernier instant");
    await at(tenantId, "2026-03-11T00:00:00Z", "user:u", "lendemain");
    const names = async (o: object) => (await listAuditEvents(tenantId, o)).events.map((e) => e.summary).sort();
    expect(await names({ from: "2026-03-10", to: "2026-03-10" })).toEqual(["dernier instant", "premier instant"]);
    expect(await names({ from: "2026-03-10" })).toEqual(["dernier instant", "lendemain", "premier instant"]);
    expect(await names({ to: "2026-03-09" })).toEqual(["veille"]);
    expect(await names({ from: "2026-02-31" })).toHaveLength(4); // jour invalide ignoré, jamais une erreur SQL
  });
  it("l'auteur distingue personne, agent et système ; combinable avec la famille", async () => {
    const { tenantId } = await makeTenant();
    await at(tenantId, "2026-03-10T10:00:00Z", "user:u1", "humain");
    await at(tenantId, "2026-03-10T10:00:01Z", "agent:marche", "agent");
    await at(tenantId, "2026-03-10T10:00:02Z", "system", "système");
    await at(tenantId, "2026-03-10T10:00:03Z", "demo", "démo");
    const names = async (actorKind: "human" | "agent" | "system") => (await listAuditEvents(tenantId, { actorKind })).events.map((e) => e.summary).sort();
    expect(await names("human")).toEqual(["humain"]);
    expect(await names("agent")).toEqual(["agent"]);
    expect(await names("system")).toEqual(["démo", "système"]);
    expect((await listAuditEvents(tenantId, { actorKind: "human", category: "EXECUTION" })).events).toHaveLength(0);
  });
  it("ne franchit jamais la frontière du propriétaire, filtres ou non", async () => {
    const a = await makeTenant(), b = await makeTenant();
    await at(a.tenantId, "2026-03-10T10:00:00Z", "user:u", "chez A");
    expect((await listAuditEvents(b.tenantId, { from: "2026-03-10", to: "2026-03-10", actorKind: "human" })).events).toHaveLength(0);
  });
  it("pagination et filtres combinés : aucun doublon ni saut ; un curseur rejoué avec un autre filtre ne plante pas", async () => {
    const { tenantId } = await makeTenant();
    for (const n of [1, 2, 3]) await at(tenantId, "2026-03-10T10:00:00Z", "user:u", "h" + n);
    await at(tenantId, "2026-03-10T10:00:00Z", "agent:x", "a1");
    const p1 = await listAuditEvents(tenantId, { actorKind: "human", limit: 2 });
    expect(p1.events).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listAuditEvents(tenantId, { actorKind: "human", limit: 2, cursor: p1.nextCursor });
    expect(p2.nextCursor).toBeNull();
    expect([...p1.events, ...p2.events].map((e) => e.summary).sort()).toEqual(["h1", "h2", "h3"]);
    const autre = await listAuditEvents(tenantId, { actorKind: "agent", limit: 2, cursor: p1.nextCursor });
    expect(autre.events.every((e) => e.actor.startsWith("agent:"))).toBe(true);
  });
});

describe("chronologie d'un logement (US-081)", () => {
  const mkOpp = async (tenantId: string, propertyId: string) => {
    const id = newId("opp");
    await db.insert(schema.opportunities).values({ id, tenantId, propertyId, code: "OPP-" + id.slice(-6), playbook: "PB-01", reasonCode: "X", title: "t", stayFrom: "2026-12-01", stayTo: "2026-12-05", dedupeKey: id, signals: {}, diagnosis: {}, candidates: [], expiresAt: "2027-01-01" });
    return id;
  };
  const mkAct = async (tenantId: string, propertyId: string, opportunityId: string) => {
    const id = newId("act");
    await db.insert(schema.revenueActions).values({ id, tenantId, propertyId, opportunityId, type: "PRICE", label: "a", target: {}, parameters: {}, simulation: {}, audit: {}, status: "DRAFT", riskLevel: "LOW", rollbackPlan: "-", idempotencyKey: id });
    return id;
  };
  it("réunit logement, dossiers et actions du logement, sans l'autre logement ni l'autre propriétaire", async () => {
    const { tenantId } = await makeTenant(), other = await makeTenant();
    const p1 = await makeProperty(tenantId), p2 = await makeProperty(tenantId, "Autre");
    const o1 = await mkOpp(tenantId, p1), o2 = await mkOpp(tenantId, p2);
    const a1 = await mkAct(tenantId, p1, o1), a2 = await mkAct(tenantId, p2, o2);
    await ev(tenantId, { entity: "Property", entityId: p1, type: "property.updated", summary: "logement 1" });
    await ev(tenantId, { entity: "Opportunity", entityId: o1, type: "opportunity.deferred", summary: "dossier 1" });
    await ev(tenantId, { entity: "RevenueAction", entityId: a1, summary: "action 1" });
    await ev(tenantId, { entity: "Property", entityId: p2, type: "property.updated", summary: "logement 2" });
    await ev(tenantId, { entity: "Opportunity", entityId: o2, type: "opportunity.deferred", summary: "dossier 2" });
    await ev(tenantId, { entity: "RevenueAction", entityId: a2, summary: "action 2" });
    await ev(other.tenantId, { entity: "Property", entityId: p1, type: "property.updated", summary: "autre propriétaire" });
    const rows = await propertyAuditTrail(tenantId, p1);
    expect(rows.map((r) => r.summary).sort()).toEqual(["action 1", "dossier 1", "logement 1"]);
    expect((await propertyAuditTrail(other.tenantId, p1)).map((r) => r.summary)).toEqual(["autre propriétaire"]);
    expect(await propertyAuditTrail(tenantId, "prop_inconnu")).toEqual([]);
    expect(await propertyAuditTrail(tenantId, p1, 2)).toHaveLength(2);
  });
  it("du plus récent au plus ancien, la limite garde les plus récents ; un événement d'un autre propriétaire portant l'id d'un dossier n'entre pas", async () => {
    const { tenantId } = await makeTenant(), other = await makeTenant();
    const p = await makeProperty(tenantId), o = await mkOpp(tenantId, p);
    const put = (t: string, createdAt: string, summary: string, entityId = o) => db.insert(schema.auditEvents).values({ id: newId("evt"), tenantId: t, actor: "system", type: "opportunity.deferred", entity: "Opportunity", entityId, summary, createdAt: new Date(createdAt) });
    await put(tenantId, "2026-03-01T10:00:00Z", "ancien");
    await put(tenantId, "2026-03-03T10:00:00Z", "récent");
    await put(tenantId, "2026-03-02T10:00:00Z", "milieu");
    await put(other.tenantId, "2026-03-04T10:00:00Z", "intrus");
    expect((await propertyAuditTrail(tenantId, p)).map((r) => r.summary)).toEqual(["récent", "milieu", "ancien"]);
    expect((await propertyAuditTrail(tenantId, p, 2)).map((r) => r.summary)).toEqual(["récent", "milieu"]);
  });
});
