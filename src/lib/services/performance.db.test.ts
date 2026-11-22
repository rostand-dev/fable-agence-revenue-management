import { describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { getPerformance, parsePerformanceQuery } from "./performance";
import { writeNights } from "./reservations-store";
import type { Snap } from "../reservations/nights";

// US-050 : les KPI canoniques lus dans les nuits de la base, isolés par locataire.
const NOW = new Date("2026-11-21T10:00:00Z"); // « aujourd'hui » = 2026-11-21 ; les 12 derniers mois complets : 2025-11 → 2026-10
async function addResa(tenantId: string, propertyId: string, s: Partial<Snap> & Pick<Snap, "checkIn" | "checkOut" | "grossRoomCents">) {
  const id = newId("res");
  const snap: Snap = { status: "CONFIRMED", channel: "AIRBNB", cleaningCents: null, commissionCents: 0, paymentFeeCents: null, ...s };
  const nights = Math.round((Date.parse(snap.checkOut) - Date.parse(snap.checkIn)) / 86_400_000);
  await db.insert(schema.reservations).values({ id, tenantId, propertyId, externalId: id, channel: snap.channel, checkIn: snap.checkIn, checkOut: snap.checkOut, nights, grossRoomCents: snap.grossRoomCents, commissionCents: snap.commissionCents, paymentFeeCents: snap.paymentFeeCents, status: snap.status, bookedAt: snap.checkIn, source: "TEST" });
  await writeNights(db, tenantId, propertyId, id, snap);
}

describe("getPerformance", () => {
  it("12 derniers mois complets, détail mensuel, cinq fenêtres à venir ; le net inconnu n'est jamais compté comme nul", async () => {
    const t = await makeTenant("perf1"), prop = await makeProperty(t.tenantId, "Perf 1");
    await addResa(t.tenantId, prop, { checkIn: "2026-10-01", checkOut: "2026-10-04", grossRoomCents: 30000, commissionCents: 4500 }); // 3 nuits, net 25 500
    await addResa(t.tenantId, prop, { checkIn: "2026-10-10", checkOut: "2026-10-12", grossRoomCents: 20000, commissionCents: null }); // 2 nuits, commission inconnue
    await addResa(t.tenantId, prop, { checkIn: "2026-10-20", checkOut: "2026-10-22", grossRoomCents: 99999, status: "CANCELLED" }); // aucune nuit
    await addResa(t.tenantId, prop, { checkIn: "2026-10-25", checkOut: "2026-10-27", grossRoomCents: 0, status: "BLOCKED" }); // 2 nuits bloquées
    await addResa(t.tenantId, prop, { checkIn: "2026-11-25", checkOut: "2026-11-28", grossRoomCents: 36000, commissionCents: 3600 }); // futur, 3 nuits
    const v = await getPerformance(t.tenantId, prop, {}, NOW);

    expect(v.period).toEqual({ from: "2025-11-01", to: "2026-11-01", custom: false });
    expect(v.today).toBe("2026-11-21"); expect(v.currency).toBe("EUR");
    expect(v.kpi).toMatchObject({ soldNights: 5, grossRoomCents: 50000, blockedNights: 2, availableNights: 365 - 2, netStatus: "PARTIAL", netNights: 3, netRoomCents: 25500, netRevpanCents: null });
    expect(v.kpi.adrCents).toBe(10000); expect(v.kpi.netAdrCents).toBe(8500);
    expect(v.monthly).toHaveLength(12);
    expect(v.monthly!.map((m) => m.month)[0]).toBe("2025-11"); expect(v.monthly!.at(-1)!.month).toBe("2026-10");
    expect(v.monthly!.at(-1)).toMatchObject({ soldNights: 5, blockedNights: 2, availableNights: 29 });
    expect(v.dataQuality).toEqual({ firstNight: "2026-10-01", soldNightsUnknownCommission: 2, overlappingNights: 0 });
    expect(v.horizons.map((h) => h.key)).toEqual(["D0_7", "D8_14", "D15_30", "D31_60", "D61_90"]);
    const d15 = v.horizons.find((h) => h.key === "D15_30")!.kpi; // 2026-12-06 → 2026-12-22 : aucun séjour
    expect(d15.soldNights).toBe(0);
    const d0 = v.horizons[0].kpi; expect(d0.period).toEqual({ from: "2026-11-21", to: "2026-11-29" }); expect(d0.soldNights).toBe(3); // nuits des 25, 26 et 27 novembre
  });

  it("période libre, nuits bloquées lues dans le calendrier, mois en cours exclu par défaut", async () => {
    const t = await makeTenant("perf2"), prop = await makeProperty(t.tenantId, "Perf 2");
    await addResa(t.tenantId, prop, { checkIn: "2026-11-02", checkOut: "2026-11-04", grossRoomCents: 20000, commissionCents: 3000 });
    await db.insert(schema.calendarDays).values([{ tenantId: t.tenantId, propertyId: prop, date: "2026-11-10", state: "BLOCKED" }, { tenantId: t.tenantId, propertyId: prop, date: "2026-11-11", state: "FREE" }] as any);
    const def = await getPerformance(t.tenantId, prop, {}, NOW);
    expect(def.kpi.soldNights).toBe(0); // novembre (mois en cours) n'est pas dans les 12 mois complets
    const v = await getPerformance(t.tenantId, prop, { from: "2026-11-01", to: "2026-11-16" }, NOW);
    expect(v.period.custom).toBe(true); expect(v.monthly).toBeNull();
    expect(v.kpi).toMatchObject({ days: 15, soldNights: 2, blockedNights: 1, availableNights: 14, netStatus: "COMPLETE", netRoomCents: 17000, netRevpanCents: Math.round(17000 / 14) });
  });

  it("isolation : un autre espace ne voit ni le logement ni ses nuits ; logement inconnu : 404", async () => {
    const a = await makeTenant("perf3a"), b = await makeTenant("perf3b");
    const pa = await makeProperty(a.tenantId, "A"), pb = await makeProperty(b.tenantId, "B");
    await addResa(a.tenantId, pa, { checkIn: "2026-10-01", checkOut: "2026-10-03", grossRoomCents: 20000 });
    await expect(getPerformance(b.tenantId, pa, {}, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getPerformance(a.tenantId, "prop_inconnu", {}, NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getPerformance(b.tenantId, pb, {}, NOW)).kpi.soldNights).toBe(0);
    expect((await getPerformance(a.tenantId, pa, {}, NOW)).kpi.soldNights).toBe(2);
  });

  it("couverture : une période antérieure à la première nuit connue est signalée, ses zéros sont des inconnus", async () => {
    const t = await makeTenant("perf5"), prop = await makeProperty(t.tenantId, "P5");
    await addResa(t.tenantId, prop, { checkIn: "2026-08-10", checkOut: "2026-08-12", grossRoomCents: 20000, commissionCents: 0 });
    const v = await getPerformance(t.tenantId, prop, { months: 12 }, NOW);
    expect(v.kpi.coverage).toBe("PARTIAL");
    expect(v.monthly!.find((m) => m.month === "2026-02")!.coverage).toBe("BEFORE_HISTORY");
    expect(v.monthly!.find((m) => m.month === "2026-08")!.coverage).toBe("PARTIAL");
    expect(v.monthly!.find((m) => m.month === "2026-09")!.coverage).toBe("FULL");
    expect((await getPerformance(t.tenantId, prop, { from: "2026-01-01", to: "2026-02-01" }, NOW)).kpi.coverage).toBe("BEFORE_HISTORY");
    const empty = await makeProperty(t.tenantId, "Vide");
    expect((await getPerformance(t.tenantId, empty, {}, NOW)).kpi.coverage).toBe("NO_HISTORY");
  });

  it("months=N : N mois complets, passage d'année, nuit vendue ET bloquée par le calendrier comptée vendue", async () => {
    const t = await makeTenant("perf6"), prop = await makeProperty(t.tenantId, "P6");
    const jan = new Date("2027-01-15T10:00:00Z");
    await addResa(t.tenantId, prop, { checkIn: "2026-12-30", checkOut: "2027-01-02", grossRoomCents: 30000, commissionCents: 0 });
    await db.insert(schema.calendarDays).values([{ tenantId: t.tenantId, propertyId: prop, date: "2026-12-30", state: "BLOCKED" }] as any);
    const v = await getPerformance(t.tenantId, prop, { months: 3 }, jan);
    expect(v.period).toEqual({ from: "2026-10-01", to: "2027-01-01", custom: false });
    expect(v.monthly!.map((m) => m.month)).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(v.monthly![2]).toMatchObject({ soldNights: 2, blockedNights: 0 });
    // l'autre locataire ne voit pas ces jours bloqués
    const o = await makeTenant("perf6b"), op = await makeProperty(o.tenantId, "O");
    expect((await getPerformance(o.tenantId, op, { months: 3 }, jan)).kpi.blockedNights).toBe(0);
  });

  it("rejette une période hors bornes", async () => {
    const t = await makeTenant("perf4"), prop = await makeProperty(t.tenantId, "P4");
    await expect(getPerformance(t.tenantId, prop, { from: "2020-01-01", to: "2026-01-01" }, NOW)).rejects.toMatchObject({ code: "INVALID" });
  });
});

describe("parsePerformanceQuery", () => {
  const q = (s: string) => parsePerformanceQuery(new URLSearchParams(s));
  it("accepte aucun paramètre, un nombre de mois ou une période", () => {
    expect(q("")).toEqual({ ok: true, value: {} });
    expect(q("months=6")).toEqual({ ok: true, value: { months: 6 } });
    expect(q("from=2026-01-01&to=2026-02-01")).toEqual({ ok: true, value: { from: "2026-01-01", to: "2026-02-01" } });
  });
  it("refuse les valeurs invalides", () => {
    for (const s of ["months=0", "months=25", "months=abc", "months=1.5", "from=2026-01-01", "to=2026-01-01", "from=2026-02-30&to=2026-03-01", "from=2026-03-01&to=2026-03-01", "from=2026-03-02&to=2026-03-01", "from=2026-01-01&to=2026-02-01&months=3", "from=x&to=y"]) expect(q(s).ok, s).toBe(false);
  });
});
