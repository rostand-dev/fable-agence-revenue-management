import { describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { recentDecisions } from "./queries";

async function opp(tenantId: string, propertyId: string, code: string, status: string, decidedAt: Date | null, decision: string | null = null) {
  const id = newId("opp");
  await db.insert(schema.opportunities).values({ id, tenantId, propertyId, code, playbook: "PB-01", reasonCode: "T", title: code, stayFrom: "2026-12-01", stayTo: "2026-12-03", dedupeKey: code, signals: [], diagnosis: {}, candidates: [], status, decision, decidedAt, expiresAt: "2026-12-31" });
  return id;
}

describe("recentDecisions", () => {
  it("rend les dix dernières décisions, de la plus récente à la plus ancienne, avec leur action", async () => {
    const t = await makeTenant("dec1"), p = await makeProperty(t.tenantId);
    const day = (n: number) => new Date(Date.UTC(2026, 10, n, 12));
    // 12 décisions créées dans le désordre : la date de décision seule classe
    for (const n of [3, 12, 1, 7, 5, 11, 2, 9, 4, 10, 6, 8]) await opp(t.tenantId, p, `D-${n}`, "DECIDED", day(n), "REJECTED");
    await opp(t.tenantId, p, "OUVERT", "OPEN", null);
    await opp(t.tenantId, p, "DIFFERE", "DEFERRED", null);
    await opp(t.tenantId, p, "EXPIRE", "EXPIRED", null);
    await opp(t.tenantId, p, "SANS-DATE", "DECIDED", null, "REJECTED");
    const approved = await opp(t.tenantId, p, "D-20", "DECIDED", day(20), "APPROVED");
    await db.insert(schema.revenueActions).values({ id: newId("act"), tenantId: t.tenantId, propertyId: p, opportunityId: approved, type: "PRICE", label: "Action approuvée", target: {}, parameters: {}, simulation: {}, audit: {}, status: "DRAFT", riskLevel: "LOW", rollbackPlan: "—", idempotencyKey: newId("idem") });
    const rows = await recentDecisions(t.tenantId);
    expect(rows.map((r) => r.code)).toEqual(["D-20", "D-12", "D-11", "D-10", "D-9", "D-8", "D-7", "D-6", "D-5", "D-4"]);
    expect(rows[0].action?.label).toBe("Action approuvée");
    expect(rows[1].action).toBeNull();
  });

  it("isole les espaces", async () => {
    const a = await makeTenant("dec2"), b = await makeTenant("dec3"), p = await makeProperty(a.tenantId);
    await opp(a.tenantId, p, "A-1", "DECIDED", new Date(), "NO_ACTION");
    expect(await recentDecisions(b.tenantId)).toEqual([]);
    expect(await recentDecisions(a.tenantId)).toHaveLength(1);
  });
});
