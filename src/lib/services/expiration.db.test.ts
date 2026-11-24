import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { addDays, todayISO } from "../dates";
import { runDailyReview } from "./review";
import { seedDemo } from "./seed";

const { opportunities } = schema;
let t: Awaited<ReturnType<typeof makeTenant>>;
beforeAll(async () => {
  t = await makeTenant("expiration");
  await seedDemo(t.tenantId);
}, 120_000);

describe("expiration des dossiers après une longue interruption des revues", () => {
  it("un dossier encore détecté dont l'échéance est dépassée est rafraîchi, pas expiré", async () => {
    await runDailyReview(t.tenantId, "MANUAL");
    const open = await db.select().from(opportunities).where(and(eq(opportunities.tenantId, t.tenantId), eq(opportunities.status, "OPEN")));
    expect(open.length).toBeGreaterThan(0);
    const past = addDays(todayISO(new Date()), -20);
    await db.update(opportunities).set({ expiresAt: past }).where(and(eq(opportunities.tenantId, t.tenantId), eq(opportunities.status, "OPEN")));
    await runDailyReview(t.tenantId, "MANUAL");
    const after = await db.select().from(opportunities).where(eq(opportunities.tenantId, t.tenantId));
    // chaque dossier encore détecté (même seed, même jour) reste le MÊME dossier, ouvert, avec une échéance repoussée : ni expiré, ni rouvert sous un nouvel id
    for (const o of open) {
      const now = after.find((x) => x.id === o.id)!;
      expect(now.status, `dossier ${o.code}`).toBe("OPEN");
      expect(now.expiresAt >= todayISO(new Date())).toBe(true);
    }
    expect(after.filter((x) => x.status === "OPEN")).toHaveLength(open.length);
  });
});
