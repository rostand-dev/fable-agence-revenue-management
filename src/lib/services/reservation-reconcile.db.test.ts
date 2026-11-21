import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import type { ShReservation } from "../integrations/superhote-map";
import { reconcileReservations } from "./reservation-ingest";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T;
beforeAll(async () => { a = await makeTenant("A-rec"); });

const sh = (id: string, o: Partial<ShReservation> = {}): ShReservation => ({ id, externalId: "HM-" + id, rentalId: "r1", channel: "AIRBNB", platformName: "Airbnb", checkIn: "2026-12-01", checkOut: "2026-12-04", nights: 3, canceled: false, bookedAt: "2026-11-01", updatedAt: "2026-11-10T10:00:00Z", totalCents: 30000, hostPayoutCents: 25500, cityTaxCents: null, cleaningCents: 5000, hostFeesCents: 4500, feeLines: [], ...o });
const run = (p: string, rows: ShReservation[], readAt = new Date()) => db.transaction((tx) => reconcileReservations(tx, { tenantId: a.tenantId, propertyId: p, model: null, reservations: rows, readAt }));
const resas = (p: string) => db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, p));
const nights = (p: string) => db.select().from(schema.reservationNights).where(eq(schema.reservationNights.propertyId, p));
/** Vieillit les réservations : la réconciliation n'annule pas ce qui vient d'être modifié (marge de 60 s). */
const age = (p: string) => db.update(schema.reservations).set({ updatedAt: new Date(Date.now() - 600_000) }).where(eq(schema.reservations.propertyId, p));
const changes = (p: string) => db.select().from(schema.reservationChanges).where(eq(schema.reservationChanges.propertyId, p));

describe("réconciliation d'une lecture complète SuperHote (US-032)", () => {
  it("première lecture : créations ; seconde identique : aucun écart, aucune écriture d'historique", async () => {
    const p = await makeProperty(a.tenantId, "Création");
    const rows = [sh("1"), sh("2", { checkIn: "2026-12-10", checkOut: "2026-12-12", nights: 2, totalCents: 20000 })];
    expect(await run(p, rows)).toMatchObject({ created: 2, modified: 0, cancelled: 0, unchanged: 0, vanished: 0, suspicious: false });
    expect(await nights(p)).toHaveLength(5);
    expect(await run(p, rows)).toMatchObject({ created: 0, modified: 0, unchanged: 2 });
    const ch = await changes(p);
    expect(ch).toHaveLength(2);
    expect(ch.every((c) => c.source === "RECONCILE" && c.kind === "CREATED")).toBe(true);
  });
  it("détecte une modification, une annulation et une réactivation manquées par les webhooks", async () => {
    const p = await makeProperty(a.tenantId, "Écarts");
    await run(p, [sh("1"), sh("2", { checkIn: "2026-12-10", checkOut: "2026-12-12", nights: 2 })]);
    const r = await run(p, [sh("1", { checkOut: "2026-12-06", nights: 5, totalCents: 50000, updatedAt: "2026-11-11T10:00:00Z" }), sh("2", { checkIn: "2026-12-10", checkOut: "2026-12-12", nights: 2, canceled: true, updatedAt: "2026-11-11T10:00:00Z" })]);
    expect(r).toMatchObject({ modified: 1, cancelled: 1, created: 0 });
    expect((await nights(p)).length).toBe(5);
    const r2 = await run(p, [sh("1", { checkOut: "2026-12-06", nights: 5, totalCents: 50000, updatedAt: "2026-11-11T10:00:00Z" }), sh("2", { checkIn: "2026-12-10", checkOut: "2026-12-12", nights: 2, updatedAt: "2026-11-12T10:00:00Z" })]);
    expect(r2).toMatchObject({ reactivated: 1, unchanged: 1 });
    expect((await changes(p)).map((c) => c.kind).sort()).toEqual(["CANCELLED", "CREATED", "CREATED", "MODIFIED", "REACTIVATED"]);
  });
  it("une réservation absente d'une lecture complète est annulée avec son historique, et libère ses nuits", async () => {
    const p = await makeProperty(a.tenantId, "Disparue");
    await run(p, [sh("1"), sh("2", { checkIn: "2026-12-10", checkOut: "2026-12-12", nights: 2 })]);
    await age(p);
    const r = await run(p, [sh("1")]);
    expect(r).toMatchObject({ vanished: 1, unchanged: 1 });
    expect((await resas(p)).find((x) => x.externalId === "2")!.status).toBe("CANCELLED");
    expect((await nights(p)).map((n) => n.night)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"]);
    expect((await changes(p)).find((c) => c.externalId === "2" && c.kind === "CANCELLED")).toMatchObject({ source: "RECONCILE" });
  });
  it("une réservation modifiée depuis le début de la lecture (webhook plus récent) n'est pas annulée", async () => {
    const p = await makeProperty(a.tenantId, "Course");
    await run(p, [sh("1")]);
    const r = await run(p, [], new Date(Date.now() - 3_600_000)); // lecture commencée avant la dernière écriture de la réservation, et vide
    expect(r.vanished).toBe(0);
    expect((await resas(p))[0].status).toBe("CONFIRMED");
  });
  it("lecture vide alors que des réservations existent : suspecte, rien n'est annulé", async () => {
    const p = await makeProperty(a.tenantId, "Suspecte");
    await run(p, [sh("1")]);
    await age(p);
    const r = await run(p, []);
    expect(r).toMatchObject({ suspicious: true, vanished: 0 });
    expect((await resas(p))[0].status).toBe("CONFIRMED");
    expect(await nights(p)).toHaveLength(3);
  });
  it("une lecture plus ancienne que l'état connu (webhook) ne l'écrase pas", async () => {
    const p = await makeProperty(a.tenantId, "Ancienne");
    await run(p, [sh("1", { checkOut: "2026-12-06", nights: 5, totalCents: 50000, updatedAt: "2026-11-12T10:00:00Z" })]);
    const r = await run(p, [sh("1", { updatedAt: "2026-11-10T10:00:00Z" })]);
    expect(r).toMatchObject({ stale: 1, modified: 0 });
    expect(await nights(p)).toHaveLength(5);
  });
  it("remplace les réservations relayées par PriceLabs ; celles de démonstration restent", async () => {
    const p = await makeProperty(a.tenantId, "Sources");
    const base = { tenantId: a.tenantId, propertyId: p, channel: "AIRBNB", checkIn: "2026-12-01", checkOut: "2026-12-04", nights: 3, grossRoomCents: 1000, status: "CONFIRMED", bookedAt: "2026-11-01" } as any;
    await db.insert(schema.reservations).values([{ ...base, id: "rs_pl_" + p, externalId: "PL-1", source: "PRICELABS" }, { ...base, id: "rs_demo_" + p, externalId: "DEMO-1", source: "DEMO", checkIn: "2027-03-01", checkOut: "2027-03-03" }]);
    await run(p, [sh("1")]);
    const rows = await resas(p);
    expect(rows.map((x) => x.externalId).sort()).toEqual(["1", "DEMO-1"]);
  });
  it("un doublon dont le jumeau disparaît redevient confirmé", async () => {
    const p = await makeProperty(a.tenantId, "Jumeaux");
    await run(p, [sh("1", { bookedAt: "2026-10-01" }), sh("2", { bookedAt: "2026-10-15", checkIn: "2026-12-02", checkOut: "2026-12-05", nights: 3 })]);
    expect((await resas(p)).find((x) => x.externalId === "1")!.status).toBe("DUPLICATE");
    await age(p);
    await run(p, [sh("1", { bookedAt: "2026-10-01" })]);
    const rows = await resas(p);
    expect(rows.find((x) => x.externalId === "2")!.status).toBe("CANCELLED");
    expect(rows.find((x) => x.externalId === "1")!.status).toBe("CONFIRMED");
    expect((await nights(p)).map((n) => n.night)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"]);
  });
  it("un séjour terminé absent de la lecture n'est pas annulé (SuperHote peut ne plus renvoyer l'ancien historique)", async () => {
    const p = await makeProperty(a.tenantId, "Historique");
    await run(p, [sh("1"), sh("9", { checkIn: "2026-01-10", checkOut: "2026-01-13", nights: 3 })]);
    await age(p);
    const r = await run(p, [sh("1")]);
    expect(r.vanished).toBe(0);
    expect((await resas(p)).find((x) => x.externalId === "9")!.status).toBe("CONFIRMED");
  });
  it("lecture vide : les réservations relayées par PriceLabs ne sont pas effacées", async () => {
    const p = await makeProperty(a.tenantId, "Sans remplacement");
    await db.insert(schema.reservations).values({ id: "rs_pl2_" + p, tenantId: a.tenantId, propertyId: p, externalId: "PL-9", channel: "AIRBNB", checkIn: "2026-12-01", checkOut: "2026-12-04", nights: 3, grossRoomCents: 1000, status: "CONFIRMED", bookedAt: "2026-11-01", source: "PRICELABS" } as any);
    await run(p, []);
    expect((await resas(p)).map((x) => x.externalId)).toEqual(["PL-9"]);
  });
  it("sous l'isolation de la base (rôle applicatif) : même résultat", async () => {
    const { withTenant } = await import("@/db/tenant");
    const p = await makeProperty(a.tenantId, "Sous RLS");
    const r = await withTenant(a.tenantId, (tx) => reconcileReservations(tx as any, { tenantId: a.tenantId, propertyId: p, model: null, reservations: [sh("1")], readAt: new Date() }), { enforce: true });
    expect(r.created).toBe(1);
    expect(await nights(p)).toHaveLength(3);
  });
});
