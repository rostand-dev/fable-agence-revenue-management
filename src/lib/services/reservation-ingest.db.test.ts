import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { withTenant } from "@/db/tenant";
import { makeProperty, makeTenant } from "@/test/db";
import type { ShReservation } from "../integrations/superhote-map";
import { applyCalendarEffect, applyReservation } from "./reservation-ingest";
import { insertReservations } from "./reservations-store";

type T = Awaited<ReturnType<typeof makeTenant>>;
let a: T, b: T;
beforeAll(async () => { a = await makeTenant("A-nuits"); b = await makeTenant("B-nuits"); });

const sh = (o: Partial<ShReservation> = {}): ShReservation => ({ id: "9001", externalId: "HM-1", rentalId: "r1", channel: "AIRBNB", platformName: "Airbnb", checkIn: "2026-12-01", checkOut: "2026-12-04", nights: 3, canceled: false, bookedAt: "2026-11-01", updatedAt: "2026-11-10T10:00:00Z", totalCents: 30000, hostPayoutCents: 25500, cityTaxCents: null, cleaningCents: 5000, hostFeesCents: 4500, feeLines: [], ...o });
const ingest = (t: T, propertyId: string, r: ShReservation, extra: { deliveryId?: string } = {}) => db.transaction((tx) => applyReservation(tx, { tenantId: t.tenantId, propertyId, model: null, reservation: r, source: "WEBHOOK", ...extra }));
const nightsOf = (propertyId: string) => db.select().from(schema.reservationNights).where(eq(schema.reservationNights.propertyId, propertyId)).orderBy(schema.reservationNights.night);
const changesOf = (propertyId: string) => db.select().from(schema.reservationChanges).where(eq(schema.reservationChanges.propertyId, propertyId));

describe("écriture unitaire d'une réservation SuperHote (US-031)", () => {
  it("création : réservation, nuits (somme exacte) et historique CREATED", async () => {
    const p = await makeProperty(a.tenantId, "Création");
    const r = await ingest(a, p, sh(), { deliveryId: "dlv_1" });
    expect(r.outcome).toBe("CREATED");
    const n = await nightsOf(p);
    expect(n.map((x) => x.night)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"]);
    const res = (await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, p)))[0];
    expect(n.reduce((s, x) => s + x.grossRoomCents, 0)).toBe(res.grossRoomCents);
    const ch = await changesOf(p);
    expect(ch).toHaveLength(1);
    expect(ch[0]).toMatchObject({ kind: "CREATED", source: "WEBHOOK", deliveryId: "dlv_1" });
  });
  it("rejouer le même état ne change rien (idempotence)", async () => {
    const p = await makeProperty(a.tenantId, "Idempotent");
    await ingest(a, p, sh());
    const again = await ingest(a, p, sh());
    expect(again.outcome).toBe("UNCHANGED");
    expect(await changesOf(p)).toHaveLength(1);
    expect(await nightsOf(p)).toHaveLength(3);
  });
  it("modification : les nuits suivent les nouvelles dates, le diff est conservé", async () => {
    const p = await makeProperty(a.tenantId, "Modif");
    await ingest(a, p, sh());
    const r = await ingest(a, p, sh({ checkOut: "2026-12-06", nights: 5, totalCents: 50000, updatedAt: "2026-11-11T10:00:00Z" }));
    expect(r.outcome).toBe("MODIFIED");
    expect(r.window).toEqual({ from: "2026-12-01", to: "2026-12-06" });
    expect(await nightsOf(p)).toHaveLength(5);
    const ch = (await changesOf(p)).find((c) => c.kind === "MODIFIED")!;
    expect((ch.changes as any[]).map((c) => c.key)).toContain("checkOut");
  });
  it("un événement plus ancien que l'état connu est ignoré (STALE)", async () => {
    const p = await makeProperty(a.tenantId, "Ordre");
    await ingest(a, p, sh({ updatedAt: "2026-11-12T10:00:00Z", checkOut: "2026-12-05", nights: 4, totalCents: 40000 }));
    const old = await ingest(a, p, sh({ updatedAt: "2026-11-10T10:00:00Z" }));
    expect(old.outcome).toBe("STALE");
    expect(await nightsOf(p)).toHaveLength(4);
    expect(await changesOf(p)).toHaveLength(1);
  });
  it("annulation : les nuits sont libérées ; réactivation : elles reviennent", async () => {
    const p = await makeProperty(a.tenantId, "Annulation");
    await ingest(a, p, sh());
    const c = await ingest(a, p, sh({ canceled: true, updatedAt: "2026-11-11T10:00:00Z" }));
    expect(c.outcome).toBe("CANCELLED");
    expect(await nightsOf(p)).toHaveLength(0);
    const re = await ingest(a, p, sh({ updatedAt: "2026-11-12T10:00:00Z" }));
    expect(re.outcome).toBe("REACTIVATED");
    expect(await nightsOf(p)).toHaveLength(3);
    expect((await changesOf(p)).map((x) => x.kind).sort()).toEqual(["CANCELLED", "CREATED", "REACTIVATED"]);
  });
  it("chevauchement : la réservation la plus ancienne devient DUPLICATE sans nuits, puis redevient confirmée si l'autre est annulée", async () => {
    const p = await makeProperty(a.tenantId, "Chevauchement");
    const second = await ingest(a, p, sh({ externalId: "HM-A", id: "1", bookedAt: "2026-10-01" }));
    expect(second.status).toBe("CONFIRMED");
    const b2 = await ingest(a, p, sh({ externalId: "HM-B", id: "2", bookedAt: "2026-10-15", checkIn: "2026-12-02", checkOut: "2026-12-05", nights: 3 }));
    expect(b2.status).toBe("CONFIRMED");
    let rows = await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, p));
    expect(rows.find((x) => x.externalId === "1")!.status).toBe("DUPLICATE");
    expect((await nightsOf(p)).map((x) => x.night)).toEqual(["2026-12-02", "2026-12-03", "2026-12-04"]);
    await ingest(a, p, sh({ externalId: "HM-B", id: "2", canceled: true, updatedAt: "2026-11-11T10:00:00Z", bookedAt: "2026-10-15", checkIn: "2026-12-02", checkOut: "2026-12-05", nights: 3 }));
    rows = await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, p));
    expect(rows.find((x) => x.externalId === "1")!.status).toBe("CONFIRMED");
    expect((await nightsOf(p)).map((x) => x.night)).toEqual(["2026-12-01", "2026-12-02", "2026-12-03"]);
    // les bascules figurent dans l'historique de la réservation concernée
    const hA = (await changesOf(p)).filter((c) => c.externalId === "1" && c.kind === "MODIFIED");
    expect(hA.map((c) => (c.after as any).status).sort()).toEqual(["CONFIRMED", "DUPLICATE"]);
  });
  it("deux webhooks simultanés pour la même nouvelle réservation : une seule création, aucune erreur", async () => {
    const p = await makeProperty(a.tenantId, "Concurrence");
    const rs = await Promise.all([ingest(a, p, sh()), ingest(a, p, sh()), ingest(a, p, sh())]);
    expect(rs.map((r) => r.outcome).sort()).toEqual(["CREATED", "UNCHANGED", "UNCHANGED"]);
    expect(await nightsOf(p)).toHaveLength(3);
    expect(await changesOf(p)).toHaveLength(1);
  });
  it("sans date de mise à jour alors qu'un état daté existe : ignoré ; l'historique ne contient que des champs de réservation", async () => {
    const p = await makeProperty(a.tenantId, "Sans date");
    await ingest(a, p, sh());
    expect((await ingest(a, p, sh({ updatedAt: null, checkOut: "2026-12-09", nights: 8 }))).outcome).toBe("STALE");
    const ch = (await changesOf(p))[0];
    expect(Object.keys(ch.after as object).sort()).toEqual(["channel", "checkIn", "checkOut", "cleaningCents", "commissionCents", "grossRoomCents", "paymentFeeCents", "status"]);
  });
  it("écriture sous l'isolation de la base (rôle applicatif)", async () => {
    const p = await makeProperty(a.tenantId, "Sous RLS");
    const r = await withTenant(a.tenantId, (tx) => applyReservation(tx as any, { tenantId: a.tenantId, propertyId: p, model: null, reservation: sh(), source: "RECONCILE" }), { enforce: true });
    expect(r.outcome).toBe("CREATED");
    expect(await nightsOf(p)).toHaveLength(3);
  });
  it("calendrier : nuits vendues par la réservation, libérées seulement si SuperHote les déclare disponibles, passé intact", async () => {
    const p = await makeProperty(a.tenantId, "Calendrier");
    const days = ["2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04"];
    await db.insert(schema.calendarDays).values(days.map((date) => ({ propertyId: p, tenantId: a.tenantId, date, priceCents: 10000, sentPriceCents: 10000, minStay: 1, state: "FREE", rule: "x", observedAt: new Date() })) as any);
    const state = async () => (await db.select().from(schema.calendarDays).where(eq(schema.calendarDays.propertyId, p)).orderBy(schema.calendarDays.date)).map((d) => d.state);
    const run = (cal: { date: string; available: boolean }[], today = "2026-11-21") => db.transaction((tx) => applyCalendarEffect(tx, p, { from: "2026-12-01", to: "2026-12-04" } as any, cal, today as any));
    await ingest(a, p, sh());
    expect(await run([], "2026-12-10")).toBe(0); // fenêtre entièrement passée
    expect(await run([])).toBe(3);
    expect(await state()).toEqual(["BOOKED", "BOOKED", "BOOKED", "FREE"]);
    await ingest(a, p, sh({ canceled: true, updatedAt: "2026-11-11T10:00:00Z" }));
    expect(await run([])).toBe(0); // pas de libération sans confirmation de SuperHote
    expect(await run(days.map((date) => ({ date, available: true })))).toBe(3);
    expect(await state()).toEqual(["FREE", "FREE", "FREE", "FREE"]);
  });
  it("lot avec un identifiant en double : la première occurrence l'emporte, ses nuits sont cohérentes", async () => {
    const p = await makeProperty(a.tenantId, "Lot doublon");
    const row = (gross: number, co: string) => ({ externalId: "X1", channel: "AIRBNB", checkIn: "2026-12-01", checkOut: co, nights: 1, grossRoomCents: gross, cleaningCents: null, commissionCents: null, paymentFeeCents: null, status: "CONFIRMED" as const, bookedAt: "2026-11-01", commissionEstimated: false });
    await db.transaction((tx) => insertReservations(tx, a.tenantId, p, [row(10000, "2026-12-03"), row(99999, "2026-12-08")], "DEMO"));
    const n = await nightsOf(p);
    expect(n).toHaveLength(2);
    expect(n.reduce((x, y) => x + y.grossRoomCents, 0)).toBe(10000);
  });
  it("supprimer la réservation emporte ses nuits (cascade)", async () => {
    const p = await makeProperty(a.tenantId, "Cascade");
    await ingest(a, p, sh());
    await db.delete(schema.reservations).where(eq(schema.reservations.propertyId, p));
    expect(await nightsOf(p)).toHaveLength(0);
  });
});

describe("cloisonnement et historique en ajout seul", () => {
  it("B ne voit ni les nuits ni l'historique de A", async () => {
    const p = await makeProperty(a.tenantId, "Privé");
    await ingest(a, p, sh());
    const nb = await withTenant(b.tenantId, (tx) => tx.select().from(schema.reservationNights).where(eq(schema.reservationNights.propertyId, p)), { enforce: true });
    const cb = await withTenant(b.tenantId, (tx) => tx.select().from(schema.reservationChanges).where(eq(schema.reservationChanges.propertyId, p)), { enforce: true });
    expect(nb).toHaveLength(0); expect(cb).toHaveLength(0);
    const na = await withTenant(a.tenantId, (tx) => tx.select().from(schema.reservationNights).where(eq(schema.reservationNights.propertyId, p)), { enforce: true });
    expect(na).toHaveLength(3);
  });
  it("l'historique ne peut ni être modifié ni supprimé par le rôle applicatif", async () => {
    const p = await makeProperty(a.tenantId, "Append-only");
    await ingest(a, p, sh());
    await expect(withTenant(a.tenantId, (tx) => tx.update(schema.reservationChanges).set({ kind: "X" }).where(eq(schema.reservationChanges.propertyId, p)), { enforce: true })).rejects.toThrow();
    await expect(withTenant(a.tenantId, (tx) => tx.delete(schema.reservationChanges).where(eq(schema.reservationChanges.propertyId, p)), { enforce: true })).rejects.toThrow();
  });
});

describe("migration 0019 (nuits)", () => {
  const st = fs.readFileSync(path.join(process.cwd(), "drizzle", "0019_reservation_nights.sql"), "utf8").split("--> statement-breakpoint").map((x) => x.trim()).filter(Boolean);
  it("reprend les réservations existantes en nuits avec la même allocation que le code, sans doublon au rejeu", async () => {
    const t = await makeTenant("C-nuits");
    const p = await makeProperty(t.tenantId, "Reprise");
    const mk = (id: string, status: string, ci: string, co: string, gross: number, com: number | null) => db.insert(schema.reservations).values({ id, tenantId: t.tenantId, propertyId: p, externalId: id, channel: "AIRBNB", checkIn: ci, checkOut: co, nights: 1, grossRoomCents: gross, commissionCents: com, status, bookedAt: "2026-11-01", source: "SUPERHOTE" } as any);
    await mk("rs_a_" + p, "CONFIRMED", "2026-12-01", "2026-12-04", 10001, 1000);
    await mk("rs_b_" + p, "CANCELLED", "2026-12-10", "2026-12-12", 5000, null);
    await mk("rs_c_" + p, "CONFIRMED", "2026-12-20", "2026-12-20", 5000, null); // 0 nuit
    for (let i = 0; i < 2; i++) for (const s of st) await db.execute(sql.raw(s));
    const n = await nightsOf(p);
    expect(n).toHaveLength(3);
    expect(n.map((x) => x.grossRoomCents)).toEqual([3334, 3334, 3333]);
    expect(n.map((x) => x.commissionCents)).toEqual([334, 333, 333]);
    // même résultat que l'allocation du code
    const { allocate } = await import("../reservations/nights");
    expect(n.map((x) => x.grossRoomCents)).toEqual(allocate(10001, 3));
    expect(n.map((x) => x.commissionCents)).toEqual(allocate(1000, 3));
  });
});
