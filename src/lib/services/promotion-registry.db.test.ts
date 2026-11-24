import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { propertyAuditTrail } from "@/lib/audit/query";
import type { Role } from "@/lib/rbac";
import { makeProperty, makeTenant } from "@/test/db";
import { declarePromotion, endPromotion, listPromotions, PromotionError, updatePromotion, verifyPromotion, type PromotionActor } from "./promotion-registry";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T, propA: string, propB: string, propA2: string;
const NOW = new Date("2026-11-24T09:00:00Z");
const as = (t: T, role: Role): PromotionActor => ({ ...t.actor, role });
const BASE = { channel: "BOOKING", kind: "MOBILE", discountPct: "10", stayFrom: "2026-12-01", stayTo: "2026-12-15" };
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof PromotionError) return e; throw e; } throw new Error("aurait dû échouer"); };
const events = (t: T, type: string) => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, type as never)));

beforeAll(async () => {
  a = await makeTenant("A-promo"); b = await makeTenant("B-promo");
  propA = await makeProperty(a.tenantId, "Châtillon"); propA2 = await makeProperty(a.tenantId, "Évry"); propB = await makeProperty(b.tenantId, "Autre espace");
});

describe("registre des promotions (US-100)", () => {
  it("déclare une promotion : active, vérifiée à l'instant, audit dans la chronologie du logement", async () => {
    const p = await declarePromotion(as(a, "OWNER"), propA, { ...BASE, externalRef: "BK-1" }, NOW);
    expect(p).toMatchObject({ tenantId: a.tenantId, propertyId: propA, channel: "BOOKING", kind: "MOBILE", label: "Tarif mobile", discountPct: 10, status: "ACTIVE", source: "MANUAL", audience: "MOBILE", externalRef: "BK-1", createdBy: a.userId, verifiedBy: a.userId });
    expect(p.verifiedAt).toEqual(NOW);
    const ev = (await events(a, "promotion.declared")).filter((e) => (e.payload as any).promotionId === p.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ entity: "Property", entityId: propA });
    expect(ev[0].summary).toContain("Châtillon");
    const trail = await propertyAuditTrail(a.tenantId, propA, 50);
    expect(trail.some((e) => e.id === ev[0].id)).toBe(true);
  });

  it("refuse un doublon (même canal, type, séjours qui se recoupent) mais accepte un autre type, d'autres séjours ou un autre logement", async () => {
    const e = await fail(declarePromotion(as(a, "OWNER"), propA, { ...BASE, stayFrom: "2026-12-10", stayTo: "2026-12-20" }, NOW));
    expect(e.code).toBe("CONFLICT"); expect(e.message).toContain("Tarif mobile");
    await declarePromotion(as(a, "OWNER"), propA, { ...BASE, kind: "COUNTRY" }, NOW);
    await declarePromotion(as(a, "OWNER"), propA, { ...BASE, stayFrom: "2026-12-15", stayTo: "2026-12-20" }, NOW);
    await declarePromotion(as(a, "OWNER"), propA2, BASE, NOW);
  });

  it("refuse une saisie invalide sans rien écrire", async () => {
    const before = (await db.select().from(schema.promotions).where(eq(schema.promotions.tenantId, a.tenantId))).length;
    expect((await fail(declarePromotion(as(a, "OWNER"), propA, { ...BASE, discountPct: "0" }, NOW))).code).toBe("INVALID");
    expect((await fail(declarePromotion(as(a, "OWNER"), propA, { ...BASE, stayFrom: "2026-01-01", stayTo: "2026-02-01" }, NOW))).message).toMatch(/déjà passés/);
    expect((await db.select().from(schema.promotions).where(eq(schema.promotions.tenantId, a.tenantId))).length).toBe(before);
  });

  it("l'annonce visée doit être celle du logement et du même canal", async () => {
    const mine = newId("lst"), other = newId("lst"), air = newId("lst");
    await db.insert(schema.listings).values([
      { id: mine, tenantId: a.tenantId, propertyId: propA, channel: "BOOKING", title: "Annonce Booking" },
      { id: other, tenantId: a.tenantId, propertyId: propA2, channel: "BOOKING", title: "Annonce d'un autre logement" },
      { id: air, tenantId: a.tenantId, propertyId: propA, channel: "AIRBNB", title: "Annonce Airbnb" },
    ]);
    expect((await fail(declarePromotion(as(a, "OWNER"), propA, { ...BASE, kind: "LIMITED", listingId: other }, NOW))).message).toMatch(/n'existe pas pour ce logement/);
    expect((await fail(declarePromotion(as(a, "OWNER"), propA, { ...BASE, kind: "LIMITED", listingId: air }, NOW))).message).toMatch(/même canal/);
    expect((await declarePromotion(as(a, "OWNER"), propA, { ...BASE, kind: "LIMITED", listingId: mine }, NOW)).listingId).toBe(mine);
  });

  it("isolation : un autre espace ne voit, ne modifie ni ne déclare rien ici", async () => {
    expect((await fail(declarePromotion(as(b, "OWNER"), propA, BASE, NOW))).code).toBe("NOT_FOUND");
    const mine = (await listPromotions(a.tenantId, propA, NOW))[0];
    expect((await fail(updatePromotion(as(b, "OWNER"), mine.id, BASE, NOW))).code).toBe("NOT_FOUND");
    expect((await fail(endPromotion(as(b, "OWNER"), mine.id, "x", NOW))).code).toBe("NOT_FOUND");
    expect((await fail(verifyPromotion(as(b, "OWNER"), mine.id, NOW))).code).toBe("NOT_FOUND");
    expect(await listPromotions(b.tenantId, propA, NOW)).toEqual([]);
    expect((await declarePromotion(as(b, "OWNER"), propB, BASE, NOW)).tenantId).toBe(b.tenantId);
  });

  it("droits : lecture seule refusée (et consignée), opérateur OTA autorisé à tenir le registre, auditeur refusé", async () => {
    const e = await fail(declarePromotion(as(a, "ANALYST"), propA2, { ...BASE, kind: "COUNTRY" }, NOW));
    expect(e.code).toBe("FORBIDDEN"); expect(e.message).toContain("Analyste");
    expect((await events(a, "access.denied")).some((x) => x.entityId === propA2)).toBe(true);
    const any = (await listPromotions(a.tenantId, propA2, NOW))[0];
    expect((await fail(endPromotion(as(a, "OWNER_VIEWER"), any.id, "", NOW))).code).toBe("FORBIDDEN");
    expect((await fail(verifyPromotion(as(a, "AUDITOR"), any.id, NOW))).code).toBe("FORBIDDEN");
    expect((await declarePromotion(as(a, "OTA_OPERATOR"), propA2, { ...BASE, kind: "LIMITED" }, NOW)).createdBy).toBe(a.userId);
  });

  it("modifie : changements consignés, vérification remise à zéro ; sans changement, rien n'est écrit", async () => {
    const p = await declarePromotion(as(a, "OWNER"), propA, { channel: "AIRBNB", kind: "LAST_MINUTE", discountPct: "8" }, NOW);
    const same = await updatePromotion(as(a, "OWNER"), p.id, { discountPct: "8", label: p.label }, NOW);
    expect(same.verifiedAt).toEqual(NOW);
    const later = new Date(+NOW + 3600_000);
    const up = await updatePromotion(as(a, "OWNER"), p.id, { discountPct: "12", label: "Dernière minute −12", minLos: "2" }, later);
    expect(up).toMatchObject({ discountPct: 12, label: "Dernière minute −12", minLos: 2, verifiedAt: null, verifiedBy: null, channel: "AIRBNB", kind: "LAST_MINUTE" });
    const ev = (await events(a, "promotion.updated")).find((e) => (e.payload as any).promotionId === p.id)!;
    expect((ev.payload as any).changes.map((c: any) => c.field).sort()).toEqual(["discountPct", "label", "minLos"]);
    expect(ev.summary).toContain("remise 8 → 12");
  });

  it("la modification ne change ni le canal ni le type, et ne crée pas de doublon", async () => {
    const [x] = (await listPromotions(a.tenantId, propA, NOW)).filter((r) => r.kind === "COUNTRY");
    const up = await updatePromotion(as(a, "OWNER"), x.id, { channel: "AIRBNB", kind: "LOS", discountPct: "11" }, NOW);
    expect(up).toMatchObject({ channel: "BOOKING", kind: "COUNTRY", discountPct: 11 });
    const [m] = (await listPromotions(a.tenantId, propA, NOW)).filter((r) => r.kind === "MOBILE" && r.stayFrom === "2026-12-15");
    // le premier « mobile » couvre le 1er au 15 décembre ; étendre le second sur ses dates le ferait se recouper
    expect((await fail(updatePromotion(as(a, "OWNER"), m.id, { discountPct: "10", stayFrom: "2026-12-10", stayTo: "2026-12-20" }, NOW))).code).toBe("CONFLICT");
  });

  it("vérifie : horodate ; refusé pour une promotion planifiée, terminée ou aux séjours passés", async () => {
    const p = await declarePromotion(as(a, "OWNER"), propA, { channel: "AIRBNB", kind: "EARLY_BIRD", discountPct: "5" }, NOW);
    const t = new Date(+NOW + 86_400_000 * 3);
    const v = await verifyPromotion(as(a, "REVENUE_MANAGER"), p.id, t);
    expect(v.verifiedAt).toEqual(t); expect(v.verifiedBy).toBe(a.userId);
    expect((await events(a, "promotion.verified")).some((e) => (e.payload as any).promotionId === p.id)).toBe(true);
    await db.update(schema.promotions).set({ status: "PLANNED" }).where(eq(schema.promotions.id, p.id));
    expect((await fail(verifyPromotion(as(a, "OWNER"), p.id, t))).message).toMatch(/pas encore appliquée/);
    await db.update(schema.promotions).set({ status: "ACTIVE", stayFrom: "2026-11-01", stayTo: "2026-11-20" }).where(eq(schema.promotions.id, p.id));
    expect((await fail(verifyPromotion(as(a, "OWNER"), p.id, t))).message).toMatch(/séjours de cette promotion sont passés/);
  });

  it("termine : motif conservé, plus modifiable ni vérifiable ni terminable, et un doublon redevient possible", async () => {
    const p = await declarePromotion(as(a, "OWNER"), propA2, { channel: "AIRBNB", kind: "CUSTOM", discountPct: "6" }, NOW);
    const e = await endPromotion(as(a, "OWNER"), p.id, "  Arrêtée dans l'extranet  ", NOW);
    expect(e).toMatchObject({ status: "ENDED", endReason: "Arrêtée dans l'extranet" }); expect(e.endedAt).toEqual(NOW);
    expect((await fail(endPromotion(as(a, "OWNER"), p.id, "", NOW))).message).toMatch(/déjà terminée/);
    expect((await fail(updatePromotion(as(a, "OWNER"), p.id, { discountPct: "7" }, NOW))).message).toMatch(/terminée/);
    expect((await fail(verifyPromotion(as(a, "OWNER"), p.id, NOW))).message).toMatch(/terminée/);
    expect((await declarePromotion(as(a, "OWNER"), propA2, { channel: "AIRBNB", kind: "CUSTOM", discountPct: "6" }, NOW)).id).not.toBe(p.id);
    expect((await events(a, "promotion.ended")).some((x) => (x.payload as any).promotionId === p.id)).toBe(true);
  });

  it("la liste classe actives, planifiées, séjours passés puis terminées, et signale un cumul inconnu", async () => {
    const t = await makeTenant("C-promo"), prop = await makeProperty(t.tenantId, "Liste");
    const u = as(t, "OWNER");
    const genius = await declarePromotion(u, prop, { channel: "BOOKING", kind: "GENIUS", discountPct: "10" }, NOW);
    const mobile = await declarePromotion(u, prop, { channel: "BOOKING", kind: "MOBILE", discountPct: "10" }, NOW);
    const done = await declarePromotion(u, prop, { channel: "AIRBNB", kind: "LOS", discountPct: "10" }, NOW);
    await endPromotion(u, done.id, "", NOW);
    const past = newId("promo");
    await db.insert(schema.promotions).values({ id: past, tenantId: t.tenantId, propertyId: prop, channel: "AIRBNB", kind: "EARLY_BIRD", label: "Ancienne", discountPct: 5, stayFrom: "2026-10-01", stayTo: "2026-11-10", status: "ACTIVE" });
    const list = await listPromotions(t.tenantId, prop, NOW);
    expect(list.map((x) => x.view.state)).toEqual(["ACTIVE", "ACTIVE", "EXPIRED", "ENDED"]);
    expect(list.find((x) => x.id === genius.id)!.unknownStackWith).toEqual(["Tarif mobile"]);
    expect(list.find((x) => x.id === mobile.id)!.unknownStackWith).toEqual(["Genius (tarif réservé aux membres)"]);
    expect(list.find((x) => x.id === past)!.view.freshness).toBe("NEVER");
  });

  it("deux déclarations simultanées identiques : une seule passe, l'autre est un doublon", async () => {
    const t = await makeTenant("D-promo"), prop = await makeProperty(t.tenantId, "Course");
    const r = await Promise.allSettled([1, 2, 3].map(() => declarePromotion(as(t, "OWNER"), prop, { channel: "AIRBNB", kind: "LOS", discountPct: "10" }, NOW)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected").every((x) => (x as PromiseRejectedResult).reason instanceof PromotionError)).toBe(true);
  });

  it("annonce supprimée : la promotion reste lisible, sans élargir la portée à toutes les annonces", async () => {
    const t = await makeTenant("E-promo"), prop = await makeProperty(t.tenantId, "Annonce");
    const l = newId("lst");
    await db.insert(schema.listings).values({ id: l, tenantId: t.tenantId, propertyId: prop, channel: "BOOKING", title: "À supprimer" });
    const p = await declarePromotion(as(t, "OWNER"), prop, { channel: "BOOKING", kind: "LIMITED", discountPct: "5", listingId: l }, NOW);
    await db.delete(schema.listings).where(eq(schema.listings.id, l));
    expect((await listPromotions(t.tenantId, prop, NOW))[0]).toMatchObject({ id: p.id, listingId: l });
  });

  it("l'audience est déduite du type, y compris pour les lignes existantes rattrapées par la migration", async () => {
    const t = await makeTenant("F-promo"), prop = await makeProperty(t.tenantId, "Audience");
    expect((await declarePromotion(as(t, "OWNER"), prop, { channel: "BOOKING", kind: "GENIUS", discountPct: "10" }, NOW)).audience).toBe("MEMBERS");
    const id = newId("promo");
    await db.insert(schema.promotions).values({ id, tenantId: t.tenantId, propertyId: prop, channel: "BOOKING", kind: "COUNTRY", label: "Ancienne", discountPct: 5 });
    await db.execute(sql`UPDATE "promotions" SET "audience" = CASE "kind" WHEN 'GENIUS' THEN 'MEMBERS' WHEN 'MOBILE' THEN 'MOBILE' WHEN 'COUNTRY' THEN 'COUNTRY' END WHERE "audience" = 'ALL' AND "kind" IN ('GENIUS', 'MOBILE', 'COUNTRY')`);
    expect((await db.select().from(schema.promotions).where(eq(schema.promotions.id, id)))[0].audience).toBe("COUNTRY");
  });
});
