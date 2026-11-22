import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { runDailyReview } from "./review";
import { seedDemo } from "./seed";

let t: Awaited<ReturnType<typeof makeTenant>>;
beforeAll(async () => { t = await makeTenant("priorisation"); await seedDemo(t.tenantId); }, 120_000);

const open = () => db.select().from(schema.opportunities).where(eq(schema.opportunities.tenantId, t.tenantId));

describe("US-062 : la priorisation réglée par l'espace s'applique à la revue", () => {
  it("chaque dossier ouvert garde le détail de son score, cohérent avec sa priorité", async () => {
    const rows = (await open()).filter((o) => o.status === "OPEN");
    expect(rows.length).toBeGreaterThan(0);
    for (const o of rows) { expect(o.signals.score, o.code).toBeTruthy(); expect(o.signals.score.score).toBeCloseTo(o.priority, 1); }
  });

  it("un poids de playbook réglé change la priorité à la revue suivante ; le rétablir remet le score d'origine", async () => {
    const rows = (await open()).filter((o) => o.status === "OPEN" && !o.veto && o.priority > 0);
    expect(rows.length, "aucun dossier chiffré dans la démonstration").toBeGreaterThan(0);
    const target = rows[0];
    const before = target.priority;
    await db.update(schema.tenants).set({ settings: { scoring: { strategicWeight: { [target.playbook]: 2 } } } }).where(eq(schema.tenants.id, t.tenantId));
    await runDailyReview(t.tenantId, "MANUAL");
    const [boosted] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, target.id));
    expect(boosted.priority).toBeGreaterThan(before);
    expect(boosted.signals.score.weight).toBe(2);
    await db.update(schema.tenants).set({ settings: {} }).where(eq(schema.tenants.id, t.tenantId));
    await runDailyReview(t.tenantId, "MANUAL");
    const [back] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, target.id));
    expect(back.priority).toBeCloseTo(before, 1);
  });

  it("une configuration enregistrée illisible ne bloque pas la revue : retour aux valeurs par défaut", async () => {
    await db.update(schema.tenants).set({ settings: { scoring: { strategicWeight: "n'importe quoi", riskPenalty: { HIGH: -4 } } } }).where(eq(schema.tenants.id, t.tenantId));
    const r = await runDailyReview(t.tenantId, "MANUAL");
    expect(r.reviewed.length).toBeGreaterThan(0);
    await db.update(schema.tenants).set({ settings: {} }).where(eq(schema.tenants.id, t.tenantId));
  });
});
