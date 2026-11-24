import { describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import type { Snap } from "../reservations/nights";
import { loadEngineInput } from "./review";

// PB-08 : l'historique des annulations et la première réservation sont chargés dans l'entrée du moteur.
const snap = (status: Snap["status"], ci = "2026-12-01", co = "2026-12-04"): Snap => ({ status, channel: "AIRBNB", checkIn: ci, checkOut: co, grossRoomCents: 30000, cleaningCents: null, commissionCents: 0, paymentFeeCents: null });
const change = (tenantId: string, propertyId: string, externalId: string, kind: string, before: Snap | null, after: Snap, at: string) =>
  db.insert(schema.reservationChanges).values({ id: newId("rch"), tenantId, propertyId, externalId, kind, source: "WEBHOOK", occurredAt: new Date(at), before, after, changes: [], createdAt: new Date(at) } as any);

describe("loadEngineInput : annulations", () => {
  it("logement jamais relu depuis SuperHote : historique inconnu, aucune annulation inventée", async () => {
    const t = await makeTenant("hist1"), prop = await makeProperty(t.tenantId, "Sans historique");
    const i = (await loadEngineInput(t.tenantId, prop, "2026-11-21", new Date("2026-11-21T10:00:00Z")))!;
    expect(i.cancellationTracking).toBeNull(); expect(i.cancellations).toEqual([]); expect(i.firstBookingDate).toBeNull();
  });
  it("annulation récente, annulation réactivée et début d'historique", async () => {
    const t = await makeTenant("hist2"), prop = await makeProperty(t.tenantId, "Avec historique");
    await db.insert(schema.reservations).values({ id: "res_h2", tenantId: t.tenantId, propertyId: prop, externalId: "res_h2", channel: "AIRBNB", checkIn: "2026-12-01", checkOut: "2026-12-04", nights: 3, grossRoomCents: 30000, status: "CONFIRMED", bookedAt: "2026-09-01", source: "TEST" });
    await change(t.tenantId, prop, "x1", "CREATED", null, snap("CONFIRMED"), "2026-10-01T09:00:00Z");
    await change(t.tenantId, prop, "x2", "CANCELLED", snap("CONFIRMED", "2026-12-10", "2026-12-12"), snap("CANCELLED", "2026-12-10", "2026-12-12"), "2026-11-18T09:00:00Z");
    await change(t.tenantId, prop, "x3", "CANCELLED", snap("CONFIRMED"), snap("CANCELLED"), "2026-11-19T09:00:00Z");
    await change(t.tenantId, prop, "x3", "REACTIVATED", snap("CANCELLED"), snap("CONFIRMED"), "2026-11-20T09:00:00Z");
    const i = (await loadEngineInput(t.tenantId, prop, "2026-11-21", new Date("2026-11-21T10:00:00Z")))!;
    expect(i.cancellationTracking).toEqual({ since: "2026-10-01" });
    expect(i.cancellations).toEqual([{ channel: "AIRBNB", checkIn: "2026-12-10", checkOut: "2026-12-12", nights: 2, grossRoomCents: 30000, cancelledAt: "2026-11-18" }]);
    expect(i.firstBookingDate).toBe("2026-09-01");
  });
  it("isolation : les changements d'un autre locataire ne sont jamais lus", async () => {
    const a = await makeTenant("hist3a"), pa = await makeProperty(a.tenantId, "A"), b = await makeTenant("hist3b"), pb = await makeProperty(b.tenantId, "B");
    await change(b.tenantId, pb, "y1", "CANCELLED", snap("CONFIRMED"), snap("CANCELLED"), "2026-11-18T09:00:00Z");
    const i = (await loadEngineInput(a.tenantId, pa, "2026-11-21", new Date("2026-11-21T10:00:00Z")))!;
    expect(i.cancellations).toEqual([]); expect(i.cancellationTracking).toBeNull();
  });
});
