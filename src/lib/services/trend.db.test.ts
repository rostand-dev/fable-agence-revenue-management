import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import type { Snap } from "../reservations/nights";
import { writeNights } from "./reservations-store";
import { monthTrend, monthTrends } from "./trend";

const NOW = new Date("2026-11-27T10:00:00Z"); // novembre comparé à octobre
async function addResa(tenantId: string, propertyId: string, s: Partial<Snap> & Pick<Snap, "checkIn" | "checkOut" | "grossRoomCents">) {
  const id = newId("res");
  const snap: Snap = { status: "CONFIRMED", channel: "AIRBNB", cleaningCents: null, commissionCents: 0, paymentFeeCents: null, ...s };
  const nights = Math.round((Date.parse(snap.checkOut) - Date.parse(snap.checkIn)) / 86_400_000);
  await db.insert(schema.reservations).values({ id, tenantId, propertyId, externalId: id, channel: snap.channel, checkIn: snap.checkIn, checkOut: snap.checkOut, nights, grossRoomCents: snap.grossRoomCents, commissionCents: snap.commissionCents, paymentFeeCents: snap.paymentFeeCents, status: snap.status, bookedAt: snap.checkIn, source: "TEST" });
  await writeNights(db, tenantId, propertyId, id, snap);
}

describe("monthTrends", () => {
  it("lit chaque logement séparément ; sans historique, la tendance est inconnue", async () => {
    const t = await makeTenant("trend1");
    const full = await makeProperty(t.tenantId, "Historique complet"), none = await makeProperty(t.tenantId, "Sans réservation"), late = await makeProperty(t.tenantId, "Historique tardif");
    await addResa(t.tenantId, full, { checkIn: "2026-09-10", checkOut: "2026-09-12", grossRoomCents: 20000 });
    await addResa(t.tenantId, full, { checkIn: "2026-10-01", checkOut: "2026-10-05", grossRoomCents: 40000 }); // 4 nuits à 100 €
    await addResa(t.tenantId, full, { checkIn: "2026-11-02", checkOut: "2026-11-10", grossRoomCents: 80000 }); // 8 nuits à 100 €
    await addResa(t.tenantId, late, { checkIn: "2026-11-02", checkOut: "2026-11-04", grossRoomCents: 20000 });
    const m = await monthTrends(t.tenantId, [full, none, late], NOW);
    expect(m.get(full)).toMatchObject({ month: "2026-11", previousMonth: "2026-10", revenue: { direction: "UP" }, occupancy: { direction: "UP" }, price: { direction: "STABLE" } });
    expect(m.get(none)!.revenue).toEqual({ direction: "UNKNOWN", reason: "aucune réservation lue" });
    expect(m.get(late)!.occupancy).toEqual({ direction: "UNKNOWN", reason: "aucun historique en octobre 2026" });
  });

  it("les blocages du calendrier réduisent les nuits disponibles", async () => {
    const t = await makeTenant("trend2"), p = await makeProperty(t.tenantId);
    await addResa(t.tenantId, p, { checkIn: "2026-09-30", checkOut: "2026-10-11", grossRoomCents: 110000 }); // 10 nuits en octobre
    await addResa(t.tenantId, p, { checkIn: "2026-11-01", checkOut: "2026-11-11", grossRoomCents: 100000 });
    expect((await monthTrend(t.tenantId, p, NOW)).occupancy.direction).toBe("STABLE"); // 10/31 contre 10/30
    await db.insert(schema.calendarDays).values(Array.from({ length: 10 }, (_, i) => ({ tenantId: t.tenantId, propertyId: p, date: `2026-11-${String(i + 15).padStart(2, "0")}`, state: "BLOCKED" })) as any);
    expect((await monthTrend(t.tenantId, p, NOW)).occupancy.direction).toBe("UP"); // 10/20
  });

  it("source reliée pas lue récemment ou en échec : inconnu, jamais « en baisse »", async () => {
    const t = await makeTenant("trend5"), p = await makeProperty(t.tenantId);
    await addResa(t.tenantId, p, { checkIn: "2026-09-01", checkOut: "2026-09-03", grossRoomCents: 20000 });
    await addResa(t.tenantId, p, { checkIn: "2026-10-01", checkOut: "2026-10-05", grossRoomCents: 40000 });
    const read = async (lastSync: { ok: boolean; at: string } | undefined) => {
      await db.update(schema.properties).set({ superhote: { rentalId: "r1", lastSync } as any }).where(eq(schema.properties.id, p));
      return (await monthTrend(t.tenantId, p, NOW)).revenue;
    };
    expect(await read({ ok: true, at: "2026-10-31T10:00:00Z" })).toEqual({ direction: "UNKNOWN", reason: "réservations pas à jour" });
    expect(await read({ ok: false, at: "2026-11-27T09:00:00Z" })).toEqual({ direction: "UNKNOWN", reason: "réservations pas à jour" });
    expect(await read(undefined)).toEqual({ direction: "UNKNOWN", reason: "réservations pas à jour" });
    // lecture récente : l'absence de réservation en novembre est un vrai zéro
    expect(await read({ ok: true, at: "2026-11-27T09:00:00Z" })).toEqual({ direction: "DOWN", reason: null });
  });

  it("isole les espaces", async () => {
    const a = await makeTenant("trend3"), b = await makeTenant("trend4"), p = await makeProperty(a.tenantId);
    await addResa(a.tenantId, p, { checkIn: "2026-10-01", checkOut: "2026-10-03", grossRoomCents: 20000 });
    expect((await monthTrends(b.tenantId, [p], NOW)).size).toBe(0);
    await expect(monthTrend(b.tenantId, p, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await monthTrends(a.tenantId, [], NOW)).toEqual(new Map());
  });
});
