import { describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { getPace } from "./pace";
import { writeNights } from "./reservations-store";
import type { Snap } from "../reservations/nights";

// US-051 : pickup et pacing lus dans la base, annulations tirées de l'historique des changements.
const NOW = new Date("2026-11-21T10:00:00Z");
async function addResa(tenantId: string, propertyId: string, o: { ci: string; co: string; bookedAt: string; status?: Snap["status"]; id?: string }) {
  const id = o.id ?? newId("res");
  const snap: Snap = { status: o.status ?? "CONFIRMED", channel: "AIRBNB", checkIn: o.ci, checkOut: o.co, grossRoomCents: 20000, cleaningCents: null, commissionCents: 0, paymentFeeCents: null };
  const n = Math.round((Date.parse(o.co) - Date.parse(o.ci)) / 86_400_000);
  await db.insert(schema.reservations).values({ id, tenantId, propertyId, externalId: id, channel: "AIRBNB", checkIn: o.ci, checkOut: o.co, nights: n, grossRoomCents: 20000, commissionCents: 0, status: snap.status, bookedAt: o.bookedAt, source: "TEST" });
  await writeNights(db, tenantId, propertyId, id, snap);
  return { id, snap };
}
const change = (tenantId: string, propertyId: string, externalId: string, kind: string, before: Snap | null, at: string) =>
  db.insert(schema.reservationChanges).values({ id: newId("rch"), tenantId, propertyId, externalId, kind, source: "WEBHOOK", occurredAt: new Date(at), before, after: before ? { ...before, status: kind === "CANCELLED" ? "CANCELLED" : "CONFIRMED" } : {}, changes: [], createdAt: new Date(at) } as any);

describe("getPace", () => {
  it("pickup par fenêtre, avec date de réservation ; pacing inconnu sans un an d'historique", async () => {
    const t = await makeTenant("pace1"), prop = await makeProperty(t.tenantId, "Pace 1");
    await addResa(t.tenantId, prop, { ci: "2026-11-23", co: "2026-11-26", bookedAt: "2026-11-21" }); // 3 nuits, pickup 1 j
    await addResa(t.tenantId, prop, { ci: "2026-11-27", co: "2026-11-28", bookedAt: "2026-11-10" }); // 1 nuit, pickup 14 j seulement
    await addResa(t.tenantId, prop, { ci: "2026-12-05", co: "2026-12-07", bookedAt: "2026-11-19" }); // D+8–14 : 2 nuits
    const v = await getPace(t.tenantId, prop, NOW);
    const d0 = v.windows[0], d8 = v.windows[1];
    expect(v.today).toBe("2026-11-21"); expect(v.firstBookingDate).toBe("2026-11-10");
    expect(d0.pickup).toEqual({ 1: 3, 3: 3, 7: 3, 14: 4 }); expect(d0.onBooksNights).toBe(4);
    expect(d8.pickup).toEqual({ 1: 0, 3: 1, 7: 1, 14: 1 }); // seule la nuit du 5 décembre est dans D+8–14 ; celle du 6 est dans D+15–30
    expect(d0).toMatchObject({ status: "UNKNOWN", unknownReason: "HISTORY_TOO_SHORT" });
  });

  it("pacing face à l'an dernier quand l'historique remonte assez loin", async () => {
    const t = await makeTenant("pace2"), prop = await makeProperty(t.tenantId, "Pace 2");
    // l'an dernier (−364 j) : fenêtre D0_7 = 2025-11-22 → 2025-11-30 ; 2 nuits réservées avant la date de comparaison (2025-11-22)
    await addResa(t.tenantId, prop, { ci: "2025-11-22", co: "2025-11-24", bookedAt: "2025-10-01" });
    await addResa(t.tenantId, prop, { ci: "2026-11-22", co: "2026-11-28", bookedAt: "2026-10-15" }); // cette année : 6 nuits
    const d0 = (await getPace(t.tenantId, prop, NOW)).windows[0];
    expect(d0).toMatchObject({ onBooksNights: 6, occupancy: 0.75, status: "AHEAD" });
    // un logement sans aucune réservation : NO_HISTORY
    const empty = await makeProperty(t.tenantId, "Vide");
    expect((await getPace(t.tenantId, empty, NOW)).windows[0]).toMatchObject({ status: "UNKNOWN", unknownReason: "NO_HISTORY" });
    expect(d0.lastYear.onBooksNights).toBe(2);
    expect(d0.gapPoints).toBeCloseTo(0.5);
  });

  it("annulation suivie d'une modification : elle reste comptée ; datée de l'enregistrement, jour limite à l'heure de Paris", async () => {
    const t = await makeTenant("pace4"), prop = await makeProperty(t.tenantId, "Pace 4");
    const a = await addResa(t.tenantId, prop, { ci: "2026-11-24", co: "2026-11-25", bookedAt: "2026-11-01", status: "CANCELLED" });
    const conf = { ...a.snap, status: "CONFIRMED" as const };
    await change(t.tenantId, prop, a.id, "CANCELLED", conf, "2026-11-20T08:00:00Z");
    await db.insert(schema.reservationChanges).values({ id: newId("rch"), tenantId: t.tenantId, propertyId: prop, externalId: a.id, kind: "MODIFIED", source: "RECONCILE", occurredAt: new Date("2026-11-01T00:00:00Z"), before: a.snap, after: { ...a.snap, grossRoomCents: 1 }, changes: [], createdAt: new Date("2026-11-21T07:00:00Z") } as any);
    const b = await addResa(t.tenantId, prop, { ci: "2026-11-26", co: "2026-11-27", bookedAt: "2026-11-01", status: "CANCELLED" });
    await change(t.tenantId, prop, b.id, "CANCELLED", { ...b.snap, status: "CONFIRMED" }, "2026-11-07T23:30:00Z"); // 8 novembre 00:30 à Paris : dans les 14 jours
    const c = await addResa(t.tenantId, prop, { ci: "2026-11-27", co: "2026-11-28", bookedAt: "2026-11-01", status: "CANCELLED" });
    await change(t.tenantId, prop, c.id, "CANCELLED", { ...c.snap, status: "CONFIRMED" }, "2026-11-07T22:30:00Z"); // 7 novembre 23:30 à Paris : hors des 14 jours
    const d0 = (await getPace(t.tenantId, prop, NOW)).windows[0];
    expect(d0.cancelled).toEqual({ 1: 0, 3: 1, 7: 1, 14: 2 }); // a (20 nov), b (8 nov) ; c (7 nov Paris) hors fenêtre
  });

  it("annulations : comptées depuis l'historique, sauf si la réservation a été réactivée depuis ; isolation locataire", async () => {
    const t = await makeTenant("pace3"), prop = await makeProperty(t.tenantId, "Pace 3");
    const a = await addResa(t.tenantId, prop, { ci: "2026-11-24", co: "2026-11-26", bookedAt: "2026-11-01", status: "CANCELLED" });
    await change(t.tenantId, prop, a.id, "CANCELLED", { ...a.snap, status: "CONFIRMED" }, "2026-11-20T08:00:00Z");
    const b = await addResa(t.tenantId, prop, { ci: "2026-11-27", co: "2026-11-28", bookedAt: "2026-11-01" });
    await change(t.tenantId, prop, b.id, "CANCELLED", { ...b.snap, status: "CONFIRMED" }, "2026-11-19T08:00:00Z");
    await change(t.tenantId, prop, b.id, "REACTIVATED", { ...b.snap, status: "CANCELLED" }, "2026-11-20T09:00:00Z");
    const d0 = (await getPace(t.tenantId, prop, NOW)).windows[0];
    expect(d0.cancelled).toEqual({ 1: 0, 3: 2, 7: 2, 14: 2 }); // seule la réservation a, annulée hier, 2 nuits
    expect(d0.onBooksNights).toBe(1); expect(d0.pickup[14]).toBe(0); // b, réactivée, est au livre mais réservée il y a plus de 14 jours : pas de pickup
    const o = await makeTenant("pace3b"), op = await makeProperty(o.tenantId, "O");
    await expect(getPace(o.tenantId, prop, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getPace(o.tenantId, op, NOW)).windows[0].cancelled[14]).toBe(0);
  });
});
