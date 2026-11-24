import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { addDays, todayISO } from "../dates";
import { loadEngineInput, runDailyReview } from "./review";
import { seedDemo } from "./seed";

const { marketGapHistory, properties, opportunities } = schema;
let t: Awaited<ReturnType<typeof makeTenant>>;
let propId: string;
beforeAll(async () => {
  t = await makeTenant("gaphist");
  await seedDemo(t.tenantId);
  propId = (await db.select().from(properties).where(eq(properties.tenantId, t.tenantId)))[0].id;
  await db.delete(opportunities).where(eq(opportunities.tenantId, t.tenantId));
}, 120_000);

const today = () => todayISO(new Date());
const rows = () => db.select().from(marketGapHistory).where(and(eq(marketGapHistory.tenantId, t.tenantId), eq(marketGapHistory.propertyId, propId)));
const obs = (day: string, windowKey: string, gap: number | null) => db.insert(marketGapHistory).values({ id: newId("mgh"), tenantId: t.tenantId, propertyId: propId, day, windowKey, gap, freeNights: 5 }).onConflictDoNothing();

describe("historique daté de l'écart au marché", () => {
  it("chaque revue écrit une ligne par fenêtre ; rejouer la revue le même jour remplace, ne duplique pas", async () => {
    await runDailyReview(t.tenantId, "MANUAL");
    const first = (await rows()).filter((r) => r.day === today());
    expect(first.length).toBe(5);
    expect(new Set(first.map((r) => r.windowKey)).size).toBe(5);
    await runDailyReview(t.tenantId, "MANUAL");
    expect((await rows()).filter((r) => r.day === today())).toHaveLength(5);
  });
  it("une fenêtre sans donnée de marché s'enregistre avec un écart inconnu (null), jamais zéro", async () => {
    const r = await rows();
    for (const x of r) if (x.marketOccupancy === null) expect(x.gap).toBeNull();
  });
  it("l'historique ancien est purgé (au-delà de 120 jours), le récent est gardé", async () => {
    await obs(addDays(today(), -200), "D15_30", -0.4);
    await obs(addDays(today(), -5), "D15_30", -0.4);
    await runDailyReview(t.tenantId, "MANUAL");
    const days = (await rows()).map((r) => r.day);
    expect(days).not.toContain(addDays(today(), -200));
    expect(days).toContain(addDays(today(), -5));
  });
  it("le moteur lit le début du retard dans l'historique : 25 jours de retard observés donnent lagSince", async () => {
    await db.delete(marketGapHistory).where(eq(marketGapHistory.propertyId, propId));
    for (let i = 1; i <= 25; i++) await obs(addDays(today(), -i), "D15_30", -0.3);
    const input = (await loadEngineInput(t.tenantId, propId, today()))!;
    expect(input.lagSince).toBe(addDays(today(), -25));
  });
  it("sans historique ni dossier : durée inconnue (null)", async () => {
    await db.delete(marketGapHistory).where(eq(marketGapHistory.propertyId, propId));
    await db.delete(opportunities).where(eq(opportunities.tenantId, t.tenantId));
    expect((await loadEngineInput(t.tenantId, propId, today()))!.lagSince).toBeNull();
  });
});
