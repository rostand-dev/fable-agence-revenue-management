import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import { db, schema } from "@/db";

const { opportunities, properties, revenueActions, reviewRuns } = schema;

export const openCount = cache(async (tenantId: string): Promise<number> => {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(opportunities).where(and(eq(opportunities.tenantId, tenantId), eq(opportunities.status, "OPEN")));
  return r?.n ?? 0;
});
export const listProperties = cache(async (tenantId: string) => db.select().from(properties).where(eq(properties.tenantId, tenantId)).orderBy(properties.createdAt));
export const lastReview = cache(async (tenantId: string) => (await db.select().from(reviewRuns).where(eq(reviewRuns.tenantId, tenantId)).orderBy(desc(reviewRuns.startedAt)).limit(1))[0] ?? null);

export async function listOpportunities(tenantId: string, statuses: string[]) {
  const rows = await db.select().from(opportunities).where(and(eq(opportunities.tenantId, tenantId), inArray(opportunities.status, statuses))).orderBy(desc(opportunities.priority), desc(opportunities.createdAt)).limit(200);
  const acts = rows.length ? await db.select().from(revenueActions).where(inArray(revenueActions.opportunityId, rows.map((r) => r.id))) : [];
  const byOpp = new Map(acts.map((a) => [a.opportunityId, a]));
  return rows.map((o) => ({ ...o, action: byOpp.get(o.id) ?? null }));
}
export type OppWithAction = Awaited<ReturnType<typeof listOpportunities>>[number];
