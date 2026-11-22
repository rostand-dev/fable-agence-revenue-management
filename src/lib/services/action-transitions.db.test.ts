import { and, asc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { ACTION_STATES, allTransitions, canTransition, type ActionState } from "../engine/stateMachine";
import { seedDemo } from "./seed";

let t: Awaited<ReturnType<typeof makeTenant>>;
let opportunityId: string, propertyId: string;
beforeAll(async () => {
  t = await makeTenant("transitions");
  await seedDemo(t.tenantId);
  const [o] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.tenantId, t.tenantId)).limit(1);
  opportunityId = o.id; propertyId = o.propertyId;
}, 120_000);

const SIM = { current: null, proposed: null, expectedDeltaCents: 0, hypothesis: "test", executionMode: "INTERNAL", measurementWindowDays: 7 };
let n = 0;
async function draft() {
  const [o] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, opportunityId));
  const c = (o.candidates as any[])[0];
  const [a] = await db.insert(schema.revenueActions).values({
    id: newId("act"), tenantId: t.tenantId, propertyId, opportunityId, type: c.type, label: c.label, target: c.target, parameters: c.parameters, simulation: SIM,
    audit: c.audit, status: "DRAFT", riskLevel: c.risk, rollbackPlan: c.rollbackPlan, idempotencyKey: `trans:${++n}:${Date.now()}`,
  } as never).returning();
  return a.id;
}
const hist = (id: string) => db.select().from(schema.actionTransitions).where(and(eq(schema.actionTransitions.tenantId, t.tenantId), eq(schema.actionTransitions.actionId, id))).orderBy(asc(schema.actionTransitions.createdAt), asc(schema.actionTransitions.id));
function path(to: ActionState): ActionState[] {
  const prev = new Map<string, string>(); const q: string[] = ["DRAFT"]; prev.set("DRAFT", "");
  while (q.length) { const c = q.shift()!; for (const [f, x] of allTransitions()) if (f === c && !prev.has(x)) { prev.set(x, c); q.push(x); } }
  const out: ActionState[] = []; for (let c: string = to; c && c !== "DRAFT"; c = prev.get(c)!) out.unshift(c as ActionState); return out;
}
async function reach(to: ActionState) { const id = await draft(); for (const s of path(to)) await db.update(schema.revenueActions).set({ status: s }).where(eq(schema.revenueActions.id, id)); return id; }

describe("déclencheur de transition (migration 0023)", () => {
  it("une action ne peut naître qu'à l'état DRAFT", async () => {
    const [o] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, opportunityId));
    const c = (o.candidates as any[])[0];
    await expect(db.insert(schema.revenueActions).values({ id: newId("act"), tenantId: t.tenantId, propertyId, opportunityId, type: c.type, label: c.label, target: c.target, parameters: c.parameters, simulation: SIM, audit: c.audit, status: "APPROVED", riskLevel: c.risk, rollbackPlan: c.rollbackPlan, idempotencyKey: `trans:bad:${Date.now()}` } as never)).rejects.toThrow();
  });
  it("la création écrit la première ligne d'historique", async () => {
    const id = await draft(); const h = await hist(id);
    expect(h).toHaveLength(1); expect(h[0].fromStatus).toBeNull(); expect(h[0].toStatus).toBe("DRAFT");
  });
  it("la base accepte exactement les transitions du graphe applicatif (toutes les paires)", async () => {
    for (const from of ACTION_STATES) {
      for (const to of ACTION_STATES) {
        if (to === from) continue; // écriture sans changement d'état : neutre, sans ligne d'historique (test dédié)
        const id = await reach(from);
        const attempt = db.update(schema.revenueActions).set({ status: to }).where(eq(schema.revenueActions.id, id));
        if (canTransition(from, to)) await attempt; else await expect(attempt, `${from}→${to}`).rejects.toThrow();
        const [a] = await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, id));
        expect(a.status).toBe(canTransition(from, to) ? to : from);
      }
    }
  }, 300_000);
  it("l'historique suit la chaîne parcourue, sans trou", async () => {
    const id = await reach("CLOSED"); const h = await hist(id);
    const chain = ["DRAFT", ...path("CLOSED")];
    expect(h.map((x) => x.toStatus)).toEqual(chain);
    h.forEach((x, i) => expect(x.fromStatus).toBe(i === 0 ? null : chain[i - 1]));
  });
  it("une mise à jour qui ne change pas l'état n'ajoute aucune ligne", async () => {
    const id = await reach("APPROVED"); const before = (await hist(id)).length;
    await db.update(schema.revenueActions).set({ label: "Libellé modifié" }).where(eq(schema.revenueActions.id, id));
    expect((await hist(id)).length).toBe(before);
  });
});
