import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { addDays, todayISO } from "@/lib/dates";
import type { Role } from "@/lib/rbac";
import { makeTenant } from "@/test/db";
import type { Candidate } from "../engine/types";
import * as D from "./decisions";
import { getExperimentOfAction, listExperiments, windowsOf, isLegacyBaseline } from "./experiments";
import { seedDemo } from "./seed";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T, other: T;
const as = (role: Role) => ({ ...t.actor, role });
const second = (role: Role) => ({ ...t.actor, id: "usr_second_reviewer", role });
/** Le déclencheur de la base refuse la modification : le pilote enveloppe l'erreur, le message utile est dans `cause`. */
const refusedAsFrozen = async (p: PromiseLike<unknown>) => {
  const err = await Promise.resolve(p).then(() => null, (e) => e as { message?: string; cause?: { message?: string } });
  expect(err, "la modification aurait dû être refusée").not.toBeNull();
  expect(`${err!.message} ${err!.cause?.message ?? ""}`).toMatch(/figée/);
};
const actionRow = async (id: string) => (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, id)))[0];

/** Approuve la première option exécutable de la démonstration qui répond au mode demandé (écriture simulée ou procédure manuelle). */
async function approveOne(mode: "API_PRICELABS" | "MANUAL_RUNBOOK", skip: Set<string>): Promise<string> {
  const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
  for (const o of opps) {
    if (skip.has(o.id)) continue;
    const i = (o.candidates as Candidate[]).findIndex((c) => c.type !== "NO_ACTION" && c.audit.verdict !== "REJECT" && c.executionMode === mode);
    if (i < 0) continue;
    await D.approve(as("OWNER"), o.id, i, "Validé après relecture du dossier.");
    skip.add(o.id);
    return (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, o.id)))[0].id;
  }
  throw new Error(`aucune option ${mode} approuvable dans la démonstration`);
}
const used = new Set<string>();
let apiAction: string, manualAction: string;

beforeAll(async () => {
  t = await makeTenant("experiences"); other = await makeTenant("experiences-autre"); await seedDemo(t.tenantId);
  apiAction = await approveOne("API_PRICELABS", used);
  manualAction = await approveOne("MANUAL_RUNBOOK", used);
}, 180_000);

describe("expérience et baseline (US-110)", () => {
  it("avant l'exécution : aucune expérience", async () => {
    expect(await getExperimentOfAction(t.tenantId, apiAction)).toBeNull();
  });

  it("l'exécution fige la baseline dans la même transaction, jour d'entrée en vigueur compris", async () => {
    await D.execute(as("OWNER"), apiAction);
    const x = (await getExperimentOfAction(t.tenantId, apiAction))!;
    expect(x).toBeTruthy();
    expect(x.status).toBe("AWAITING_VERIFICATION");
    expect(x.effectiveOn).toBe(todayISO());
    expect(isLegacyBaseline(x.baseline)).toBe(false);
    const b = x.baseline as any;
    expect(b.version).toBe(1);
    expect(b.window).toEqual({ from: addDays(todayISO(), -14), to: todayISO(), days: 14 });
    expect(x.baselineFrom).toBe(b.window.from);
    expect(x.baselineTo).toBe(b.window.to);
    expect(x.observeFrom).toBeNull();
    expect(x.observeTo).toBeNull();
    const o = (await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, x.opportunityId)))[0];
    // séjours visés ramenés aux nuits encore à venir, jamais au-delà du dossier
    if (x.stayFrom) { expect(x.stayFrom >= o.stayFrom).toBe(true); expect(x.stayFrom >= todayISO()).toBe(true); expect(x.stayTo).toBe(o.stayTo); }
    // la baseline n'invente rien : le rythme de référence ne dépasse jamais les nuits visées
    if (b.pickup && b.stay) expect(b.pickup.nights).toBeLessThanOrEqual(b.stay.nights);
  });

  it("une seule expérience par action, même si l'enregistrement est rejoué", async () => {
    const rows = await db.select().from(schema.experiments).where(eq(schema.experiments.actionId, apiAction));
    expect(rows).toHaveLength(1);
    await expect(db.insert(schema.experiments).values({ ...rows[0], id: "exp_dup" })).rejects.toThrow();
  });

  it("la baseline est immuable (déclencheur de la base) ; l'état et la fenêtre d'observation, eux, évoluent", async () => {
    const x = (await getExperimentOfAction(t.tenantId, apiAction))!;
    await refusedAsFrozen(db.update(schema.experiments).set({ baseline: { version: 1, falsifiee: true } }).where(eq(schema.experiments.id, x.id)));
    await refusedAsFrozen(db.update(schema.experiments).set({ effectiveOn: "2020-01-01" }).where(eq(schema.experiments.id, x.id)));
    await refusedAsFrozen(db.update(schema.experiments).set({ baselineFrom: "2020-01-01" }).where(eq(schema.experiments.id, x.id)));
    await refusedAsFrozen(db.update(schema.experiments).set({ stayTo: "2030-01-01" }).where(eq(schema.experiments.id, x.id)));
    const after = (await getExperimentOfAction(t.tenantId, apiAction))!;
    expect(after.baseline).toEqual(x.baseline);
    await db.update(schema.experiments).set({ updatedAt: new Date() }).where(eq(schema.experiments.id, x.id)); // sans effet sur la baseline : accepté
  });

  it("la vérification fixe la fenêtre d'observation : de l'entrée en vigueur au jour de la mesure exclu", async () => {
    await D.verify(as("OWNER"), apiAction);
    const a = await actionRow(apiAction), x = (await getExperimentOfAction(t.tenantId, apiAction))!;
    expect(a.status).toBe("MEASURING");
    expect(x.status).toBe("OBSERVING");
    expect(x.observeFrom).toBe(x.effectiveOn);
    expect(x.observeTo).toBe(a.measureDueAt);
    expect(windowsOf(x).observation).toEqual({ from: x.effectiveOn, to: a.measureDueAt });
    expect(windowsOf(x).baseline).toEqual({ from: x.baselineFrom, to: x.baselineTo });
  });

  it("procédure manuelle : la date d'entrée en vigueur déclarée par l'opérateur est celle de la baseline", async () => {
    const declared = addDays(todayISO(), -2);
    // l'approbation date de plus de deux jours : la date d'entrée en vigueur déclarée peut alors être antérieure à aujourd'hui
    await db.update(schema.revenueActions).set({ approvedAt: new Date(Date.now() - 5 * 86_400_000) }).where(eq(schema.revenueActions.id, manualAction));
    const a0 = await actionRow(manualAction);
    await D.execute(as("OTA_OPERATOR"), manualAction, { scope: String(a0.label).slice(0, 80) || "Action appliquée", date: declared, proof: "Capture de l'extranet", externalRef: "REF-42" });
    const x = (await getExperimentOfAction(t.tenantId, manualAction))!;
    expect(x.effectiveOn).toBe(declared);
    expect((x.baseline as any).window).toEqual({ from: addDays(declared, -14), to: declared, days: 14 });
    expect(x.status).toBe("AWAITING_VERIFICATION");
  });

  it("retour arrière : l'expérience est annulée, sans mesure ; une expérience annulée n'est plus relancée", async () => {
    await D.rollback(as("OWNER"), manualAction, "Annulation de test");
    const x = (await getExperimentOfAction(t.tenantId, manualAction))!;
    expect(x.status).toBe("CANCELLED");
    expect((await actionRow(manualAction)).status).toBe("ROLLED_BACK");
  });

  it("isolation : un autre espace ne voit ni l'expérience ni sa baseline", async () => {
    expect(await getExperimentOfAction(other.tenantId, apiAction)).toBeNull();
    expect(await listExperiments(other.tenantId)).toEqual([]);
    const mine = await listExperiments(t.tenantId);
    expect(mine.map((x) => x.actionId)).toEqual(expect.arrayContaining([apiAction, manualAction]));
    expect(mine.every((x) => x.tenantId === t.tenantId)).toBe(true);
  });

  it("filtre par logement et borne le nombre de lignes lues", async () => {
    const one = (await getExperimentOfAction(t.tenantId, apiAction))!;
    expect((await listExperiments(t.tenantId, { propertyId: one.propertyId })).every((x) => x.propertyId === one.propertyId)).toBe(true);
    expect(await listExperiments(t.tenantId, { limit: 1 })).toHaveLength(1);
    expect((await listExperiments(t.tenantId, { limit: -5 })).length).toBeLessThanOrEqual(500);
  });

  it("suppression du logement (cascade) : les expériences disparaissent avec lui, celles des autres espaces restent", async () => {
    const count = async (tenantId: string) => (await db.execute(sql`select count(*)::int as n from experiments where tenant_id = ${tenantId}`).then((r) => r.rows as { n: number }[]))[0].n;
    expect(await count(t.tenantId)).toBeGreaterThanOrEqual(2);
    await db.delete(schema.properties).where(eq(schema.properties.tenantId, t.tenantId));
    expect(await count(t.tenantId)).toBe(0);
    expect(await count(other.tenantId)).toBe(0);
  });
});
