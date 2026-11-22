import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { cooldownDaysOf } from "../engine/lifecycle";
import * as D from "./decisions";
import { runDailyReview } from "./review";
import { seedDemo } from "./seed";

let t: Awaited<ReturnType<typeof makeTenant>>;
beforeAll(async () => { t = await makeTenant("cycle-dossiers"); await seedDemo(t.tenantId); }, 120_000);

const all = () => db.select().from(schema.opportunities).where(eq(schema.opportunities.tenantId, t.tenantId));

describe("US-061 : déduplication, regroupement et repos dans la revue", () => {
  it("rejouer la revue ne duplique aucun dossier ouvert (une clé = un dossier)", async () => {
    const before = (await all()).filter((o) => o.status === "OPEN");
    const r = await runDailyReview(t.tenantId, "MANUAL");
    const after = (await all()).filter((o) => o.status === "OPEN");
    expect(r.opened).toBeLessThanOrEqual(before.length);
    expect(after.length).toBe(before.length);
    const keys = after.map((o) => o.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("chaque dossier ouvert porte une clé de regroupement de son logement", async () => {
    for (const o of (await all()).filter((x) => x.status === "OPEN")) expect(o.groupKey, o.code).toMatch(new RegExp(`^${o.propertyId}\\|\\d{4}-\\d{2}-\\d{2}$`));
  });

  it("une décision enregistre sa date ; le signal reste au repos, puis revient une fois la période écoulée", async () => {
    const open = (await all()).find((o) => o.status === "OPEN" && !o.veto);
    expect(open, "aucun dossier ouvert sans veto dans la démonstration").toBeTruthy();
    await D.reject(t.actor, open!.id, "Refus de test pour la période de repos.");
    const [decided] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, open!.id));
    expect(decided.status).toBe("DECIDED");
    expect(decided.decidedAt).toBeTruthy();
    const duringRun = await runDailyReview(t.tenantId, "MANUAL");
    expect(duringRun.resting, "le signal doit être compté en repos, pas simplement avoir disparu").toBeGreaterThanOrEqual(1);
    const during = (await all()).filter((o) => o.dedupeKey === decided.dedupeKey && o.status === "OPEN");
    expect(during, "le repos doit empêcher la réouverture").toHaveLength(0);
    // la période écoulée (la décision remonte au-delà de la durée du playbook), le même signal rouvre un dossier
    const old = new Date(+Date.now() - (cooldownDaysOf(decided.playbook) + 2) * 86400000);
    await db.update(schema.opportunities).set({ decidedAt: old }).where(eq(schema.opportunities.id, decided.id));
    await runDailyReview(t.tenantId, "MANUAL");
    const after = (await all()).filter((o) => o.dedupeKey === decided.dedupeKey && o.status === "OPEN");
    expect(after).toHaveLength(1);
  });

  it("rouvrir un dossier remet sa date de décision à zéro", async () => {
    const d = (await all()).find((o) => o.status === "DECIDED" && o.decidedAt && o.decision === "REJECTED");
    expect(d, "aucun dossier refusé").toBeTruthy();
    await D.reopen(t.actor, d!.id);
    const [r] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, d!.id));
    expect(r.status).toBe("OPEN");
    expect(r.decidedAt).toBeNull();
  });
});
