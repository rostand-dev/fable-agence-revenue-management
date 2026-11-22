import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { REFERENCE_EXPECTED as X, REFERENCE_SAMPLE } from "@/test/reference-sample";
import { makeProperty, makeTenant } from "@/test/db";
import { reconcile } from "../metrics/reconcile";
import { getPerformance } from "./performance";
import { writeNights } from "./reservations-store";
import type { Snap } from "../reservations/nights";

// US-054 : l'échantillon de référence (montants calculés à la main) traverse la vraie base ; les KPI lus par le service et l'API égalent les valeurs attendues.
const NOW = new Date("2026-11-21T10:00:00Z");
async function seed(tenantId: string, propertyId: string) {
  for (const r of REFERENCE_SAMPLE) {
    const snap: Snap = { status: "CONFIRMED", channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, grossRoomCents: r.grossRoomCents, cleaningCents: null, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents };
    const id = newId("res");
    await db.insert(schema.reservations).values({ id, tenantId, propertyId, externalId: id, channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, nights: r.nights, grossRoomCents: r.grossRoomCents, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents, status: "CONFIRMED", bookedAt: r.checkIn, source: "TEST" } as never);
    await writeNights(db, tenantId, propertyId, id, snap);
  }
}

describe("réconciliation de l'échantillon de référence en base (US-054)", () => {
  it("les KPI du service égalent les valeurs calculées à la main, au centime, sur la période et sur octobre", async () => {
    const t = await makeTenant("recon1"), prop = await makeProperty(t.tenantId, "Référence");
    await seed(t.tenantId, prop);
    const v = await getPerformance(t.tenantId, prop, { from: X.period.from, to: X.period.to }, NOW);
    expect(v.kpi).toMatchObject({ soldNights: X.soldNights, grossRoomCents: X.grossRoomCents, netRoomCents: X.netRoomCents, adrCents: X.adrCents, netAdrCents: X.netAdrCents, grossRevpanCents: X.grossRevpanCents, netRevpanCents: X.netRevpanCents, netStatus: "COMPLETE", availableNights: X.days });
    const oct = await getPerformance(t.tenantId, prop, { from: X.october.from, to: X.october.to }, NOW);
    expect(oct.kpi).toMatchObject({ soldNights: X.octoberSoldNights, grossRoomCents: X.octoberGross, netRoomCents: X.octoberNet, adrCents: X.octoberAdr, netAdrCents: X.octoberNetAdr });
    expect(v.dataQuality.overlappingNights).toBe(0);
    // le résultat par mois est cohérent avec la période libre
    const twelve = await getPerformance(t.tenantId, prop, {}, NOW);
    const sept = twelve.monthly!.find((m) => m.month === "2026-09")!, octm = twelve.monthly!.find((m) => m.month === "2026-10")!;
    expect(sept.soldNights + octm.soldNights).toBe(X.soldNights);
  });
  it("rejouer l'écriture des nuits ne double rien (idempotence) ; un autre espace ne voit rien", async () => {
    const t = await makeTenant("recon2"), other = await makeTenant("recon3"), prop = await makeProperty(t.tenantId, "Idempotent"), prop2 = await makeProperty(other.tenantId, "Autre");
    await seed(t.tenantId, prop);
    const rs = await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, prop));
    for (const r of rs) await writeNights(db, t.tenantId, prop, r.id, { status: "CONFIRMED", channel: r.channel, checkIn: r.checkIn, checkOut: r.checkOut, grossRoomCents: r.grossRoomCents, cleaningCents: null, commissionCents: r.commissionCents, paymentFeeCents: r.paymentFeeCents } as Snap);
    const v = await getPerformance(t.tenantId, prop, { from: X.period.from, to: X.period.to }, NOW);
    expect(v.kpi.soldNights).toBe(X.soldNights); expect(v.kpi.grossRoomCents).toBe(X.grossRoomCents);
    expect((await getPerformance(other.tenantId, prop2, { from: X.period.from, to: X.period.to }, NOW)).kpi.soldNights).toBe(0);
    // le logement d'un autre espace est introuvable : le filtre par locataire est bien en place
    await expect(getPerformance(other.tenantId, prop, { from: X.period.from, to: X.period.to }, NOW)).rejects.toThrow();
  });
  it("les montants stockés réconcilient avec le relevé de la source : conforme à ±1 %", async () => {
    const t = await makeTenant("recon4"), prop = await makeProperty(t.tenantId, "Relevé");
    await seed(t.tenantId, prop);
    const stored = await db.select().from(schema.reservations).where(eq(schema.reservations.propertyId, prop));
    const src = new Map(REFERENCE_SAMPLE.map((r) => [`${r.checkIn}|${r.channel}`, r.sourceNetRoomCents])); // arrivée et canal sont uniques dans l'échantillon
    const r = reconcile(stored.map((s) => ({ id: s.id, channel: s.channel, app: s, sourceNetRoomCents: src.get(`${s.checkIn}|${s.channel}`) ?? null })));
    expect(r).toMatchObject({ status: "OK", sampleSize: 12, compared: 12, unknown: 0 });
    expect(r.maxGapPct!).toBeLessThanOrEqual(1);
  });
});
