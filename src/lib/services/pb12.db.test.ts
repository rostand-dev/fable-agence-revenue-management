import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { addDays, todayISO } from "../dates";
import { loadEngineInput } from "./review";
import { seedDemo } from "./seed";

const { opportunities, properties } = schema;
let t: Awaited<ReturnType<typeof makeTenant>>;
let propId: string;
beforeAll(async () => {
  t = await makeTenant("pb12");
  await seedDemo(t.tenantId);
  propId = (await db.select().from(properties).where(eq(properties.tenantId, t.tenantId)))[0].id;
  // aucun dossier de rythme n'existe au départ pour ce test
  await db.delete(opportunities).where(and(eq(opportunities.tenantId, t.tenantId), eq(opportunities.propertyId, propId)));
}, 120_000);

const row = (playbook: string, status: string, createdAt: Date, signals: Record<string, unknown> = {}) =>
  db.insert(opportunities).values({
    id: newId("opp"), tenantId: t.tenantId, propertyId: propId, code: newId("c"), playbook, reasonCode: "X", title: "t", stayFrom: "2026-12-01", stayTo: "2026-12-05", dedupeKey: newId("k"),
    signals, diagnosis: {}, candidates: [], status, createdAt, expiresAt: "2027-01-01",
  } as any);
const lag = async () => (await loadEngineInput(t.tenantId, propId, todayISO(new Date())))!.lagSince;

describe("PB-12 · ancienneté du retard lue en base", () => {
  it("aucun dossier de rythme vivant : durée inconnue (null), jamais zéro", async () => {
    expect(await lag()).toBeNull();
  });
  it("le plus ancien dossier PB-01 vivant donne la date ; un dossier expiré ne compte pas", async () => {
    await row("PB-01", "EXPIRED", new Date(Date.now() - 90 * 86400000));
    await row("PB-01", "OPEN", new Date(Date.now() - 10 * 86400000));
    await row("PB-01", "DECIDED", new Date(Date.now() - 30 * 86400000));
    expect(await lag()).toBe(todayISO(new Date(Date.now() - 30 * 86400000)));
  });
  it("un dossier PB-12 porte l'ancienneté d'origine (`lagSince`) plutôt que sa date de création", async () => {
    const old = addDays(todayISO(new Date()), -50);
    await row("PB-12", "OPEN", new Date(), { lagSince: old });
    expect(await lag()).toBe(old);
  });
});
