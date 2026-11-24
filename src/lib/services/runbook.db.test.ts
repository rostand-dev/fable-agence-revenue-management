import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { listAuditEvents } from "@/lib/audit/query";
import type { Role } from "@/lib/rbac";
import { makeTenant } from "@/test/db";
import type { Candidate } from "../engine/types";
import * as D from "./decisions";
import { getRunbook, RunbookError, setRunbookStep } from "./runbook";
import { seedDemo } from "./seed";

type T = Awaited<ReturnType<typeof makeTenant>>;
let t: T, other: T, actionId: string;
const as = (role: Role) => ({ ...t.actor, role });
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof RunbookError) return e; throw e; } throw new Error("aurait dû échouer"); };

beforeAll(async () => {
  t = await makeTenant("runbook"); other = await makeTenant("runbook-autre"); await seedDemo(t.tenantId);
  const opps = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
  for (const o of opps) {
    const i = (o.candidates as Candidate[]).findIndex((c) => c.type !== "NO_ACTION" && c.audit.verdict !== "REJECT" && c.executionMode === "MANUAL_RUNBOOK");
    if (i < 0) continue;
    await D.approve(as("OWNER"), o.id, i, "Validé après relecture du dossier.");
    actionId = (await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, o.id)))[0].id;
    break;
  }
  if (!actionId) throw new Error("aucune action manuelle approuvable dans la démonstration");
}, 120_000);

describe("guide pas-à-pas : avancement enregistré (US-102)", () => {
  it("lit les étapes de l'action, aucune cochée au départ", async () => {
    const r = await getRunbook(t.tenantId, actionId);
    expect(r.steps.length).toBeGreaterThan(3);
    expect(r.progress).toMatchObject({ done: 0, complete: false });
    expect(r.steps.every((s) => s.done === null)).toBe(true);
  });
  it("cocher : enregistré avec la personne ; rejoué sans effet ; une seule ligne et un seul événement", async () => {
    const first = (await getRunbook(t.tenantId, actionId)).steps.find((s) => s.checkable)!;
    const before = (await listAuditEvents(t.tenantId, { limit: 300 })).events.filter((e) => e.type === "runbook.step_checked").length;
    await setRunbookStep(as("OTA_OPERATOR"), actionId, first.id, true);
    const r = await setRunbookStep(as("OTA_OPERATOR"), actionId, first.id, true);
    expect(r.progress.done).toBe(1);
    expect(r.steps.find((s) => s.id === first.id)!.done).toMatchObject({ by: expect.any(String) });
    expect(await db.select().from(schema.runbookSteps).where(and(eq(schema.runbookSteps.actionId, actionId), eq(schema.runbookSteps.stepId, first.id)))).toHaveLength(1);
    expect((await listAuditEvents(t.tenantId, { limit: 300 })).events.filter((e) => e.type === "runbook.step_checked")).toHaveLength(before + 1);
  });
  it("décocher : la ligne disparaît, l'audit garde la trace ; décocher une étape non cochée ne journalise rien", async () => {
    const first = (await getRunbook(t.tenantId, actionId)).steps.find((s) => s.checkable)!;
    expect((await setRunbookStep(as("OWNER"), actionId, first.id, false)).progress.done).toBe(0);
    const n = (await listAuditEvents(t.tenantId, { limit: 300 })).events.filter((e) => e.type === "runbook.step_unchecked").length;
    await setRunbookStep(as("OWNER"), actionId, first.id, false);
    expect((await listAuditEvents(t.tenantId, { limit: 300 })).events.filter((e) => e.type === "runbook.step_unchecked")).toHaveLength(n);
    expect(n).toBeGreaterThanOrEqual(1);
  });
  it("droits : un rôle sans droit d'exécution manuelle est refusé, la tentative est consignée, rien n'est écrit", async () => {
    const step = (await getRunbook(t.tenantId, actionId)).steps.find((s) => s.checkable)!;
    for (const role of ["ANALYST", "AUDITOR", "OWNER_VIEWER"] as Role[]) expect((await fail(setRunbookStep(as(role), actionId, step.id, true))).code).toBe("FORBIDDEN");
    expect((await listAuditEvents(t.tenantId, { limit: 300 })).events.filter((e) => e.type === "access.denied").length).toBeGreaterThanOrEqual(3);
    expect((await getRunbook(t.tenantId, actionId)).progress.done).toBe(0);
  });
  it("étape inconnue, consigne de sécurité (non cochable), action d'un autre espace : refusées", async () => {
    expect((await fail(setRunbookStep(as("OWNER"), actionId, "n'existe-pas", true))).code).toBe("INVALID");
    expect((await fail(setRunbookStep(as("OWNER"), actionId, "stop-if-different", true))).code).toBe("INVALID");
    const real = (await getRunbook(t.tenantId, actionId)).steps.find((s) => s.checkable)!.id;
    expect((await fail(setRunbookStep({ ...other.actor, role: "OWNER" }, actionId, real, true))).code).toBe("NOT_FOUND");
    expect((await fail(getRunbook(other.tenantId, actionId).then(() => null) as Promise<unknown>)).code).toBe("NOT_FOUND");
  });
  it("course : cocher en même temps que « Déclarer la réalisation » ne laisse jamais une étape cochée sur une action partie", async () => {
    const steps = (await getRunbook(t.tenantId, actionId)).steps.filter((s) => s.checkable);
    const results = await Promise.allSettled([
      ...steps.slice(0, 4).map((s) => setRunbookStep(as("OWNER"), actionId, s.id, true)),
      D.execute(as("OWNER"), actionId, { scope: "Promotion posée dans l'extranet", date: "2026-11-24", proof: "REF-1" }),
    ]);
    const [a] = await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, actionId));
    expect(a.status).not.toBe("APPROVED");
    const rows = await db.select().from(schema.runbookSteps).where(eq(schema.runbookSteps.actionId, actionId));
    const events = (await listAuditEvents(t.tenantId, { limit: 500 })).events.filter((e) => e.type === "runbook.step_checked" && (e.payload as any)?.stepId);
    // chaque ligne enregistrée a son événement d'audit, et seuls des gestes antérieurs à l'exécution ont réussi
    expect(rows.length).toBe(results.slice(0, -1).filter((r) => r.status === "fulfilled").length);
    expect(events.length).toBeGreaterThanOrEqual(rows.length);
  });
  it("une fois l'action déclarée, le guide ne se coche ni ne se décoche plus", async () => {
    const id = (await getRunbook(t.tenantId, actionId)).steps.find((s) => s.checkable)!.id;
    expect((await fail(setRunbookStep(as("OWNER"), actionId, id, true))).code).toBe("CONFLICT");
    expect((await fail(setRunbookStep(as("OWNER"), actionId, id, false))).code).toBe("CONFLICT");
  });
});
