import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { addDays, todayISO } from "../dates";
import type { Candidate } from "../engine/types";
import { loadEngineInput, runDailyReview } from "./review";
import { seedDemo } from "./seed";

const { opportunities, properties, reservationChanges } = schema;
let t: Awaited<ReturnType<typeof makeTenant>>;
let propId: string;
beforeAll(async () => {
  t = await makeTenant("pb08");
  await seedDemo(t.tenantId);
  propId = (await db.select().from(properties).where(eq(properties.tenantId, t.tenantId)))[0].id;
}, 120_000);

const snap = (status: string, ci: string, co: string) => ({ status, channel: "AIRBNB", checkIn: ci, checkOut: co, grossRoomCents: 30000, cleaningCents: null, commissionCents: 0, paymentFeeCents: null });
const change = (externalId: string, kind: string, before: unknown, after: unknown, at: Date) =>
  db.insert(reservationChanges).values({ id: newId("rch"), tenantId: t.tenantId, propertyId: propId, externalId, kind, source: "WEBHOOK", occurredAt: at, before, after, changes: [], createdAt: at } as any);
const pb08 = () => db.select().from(opportunities).where(and(eq(opportunities.tenantId, t.tenantId), eq(opportunities.propertyId, propId), eq(opportunities.playbook, "PB-08")));

describe("PB-08 sur une base réelle", () => {
  it("sans historique de changements : aucun dossier, jamais « zéro annulation »", async () => {
    await runDailyReview(t.tenantId, "MANUAL");
    expect(await pb08()).toHaveLength(0);
  });
  it("une annulation d'hier sur des nuits libres ouvre un dossier de relecture, une seule fois même si la revue est rejouée", async () => {
    const today = todayISO(new Date());
    const input = (await loadEngineInput(t.tenantId, propId, today))!;
    const free = input.days.filter((d) => d.state === "FREE" && d.date >= addDays(today, 3));
    const start = free.find((d, i) => free[i + 1]?.date === addDays(d.date, 1) && free[i + 2]?.date === addDays(d.date, 2));
    expect(start, "le calendrier de démonstration doit contenir trois nuits libres consécutives").toBeTruthy();
    const ci = start!.date, co = addDays(ci, 3);
    await change("hist-0", "CREATED", null, snap("CONFIRMED", "2026-01-10", "2026-01-12"), new Date(Date.now() - 30 * 86400000)); // début d'historique
    await change("cx-1", "CANCELLED", snap("CONFIRMED", ci, co), snap("CANCELLED", ci, co), new Date(Date.now() - 86400000));
    await runDailyReview(t.tenantId, "MANUAL");
    await runDailyReview(t.tenantId, "MANUAL");
    const rows = await pb08();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "OPEN", reasonCode: "DATES_REOPENED", stayFrom: ci, stayTo: co });
    const c = rows[0].candidates as Candidate[];
    expect(c[rows[0].selected].type).toBe("INVESTIGATION");
    expect(c.map((x) => x.type)).toEqual(["INVESTIGATION", "NO_ACTION"]);
  });
});
