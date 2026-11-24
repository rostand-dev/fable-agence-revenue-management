import { todayISO } from "@/lib/dates";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import * as audit from "@/lib/audit/log";
import { listAuditEvents } from "@/lib/audit/query";
import { makeTenant } from "@/test/db";
import type { Candidate } from "../engine/types";
import * as D from "./decisions";
import { seedDemo } from "./seed";

vi.mock("@/lib/audit/log", async (orig) => { const m = await orig<typeof import("@/lib/audit/log")>(); return { ...m, recordAudit: vi.fn(m.recordAudit) }; });

let t: Awaited<ReturnType<typeof makeTenant>>;
beforeAll(async () => {
  t = await makeTenant("décisions");
  await seedDemo(t.tenantId); // logements de démonstration + première revue : de vrais dossiers ouverts
}, 120_000);

const open = () => db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, t.tenantId), eq(schema.opportunities.status, "OPEN")));
const types = async (extra?: Parameters<typeof listAuditEvents>[1]) => (await listAuditEvents(t.tenantId, { limit: 200, ...extra })).events;
/** Un dossier dont une option approuvable s'exécute par écriture simulée (démonstration) */
async function approvable(mode: string) {
  for (const o of await open()) {
    const i = (o.candidates as Candidate[]).findIndex((c) => c.executionMode === mode && c.audit.verdict !== "REJECT" && c.type !== "NO_ACTION");
    if (i >= 0) return { o, i, c: (o.candidates as Candidate[])[i] };
  }
  return null;
}

describe("cycle de décision : chaque étape est tracée dans la même transaction", () => {
  it("la démonstration produit des dossiers ouverts", async () => { expect((await open()).length).toBeGreaterThan(2); });

  it("approuver → exécuter → vérifier → retour arrière : un événement par étape, avec son détail", async () => {
    const pick = (await approvable("API_PRICELABS")) ?? (await approvable("INTERNAL"));
    expect(pick, "aucun dossier approuvable dans la démonstration").not.toBeNull();
    const { o, i, c } = pick!;
    const needsComment = D.commentRequired(c);
    const actionId = (await D.approve(t.actor, o.id, i, needsComment ? "Validé après relecture du dossier." : "Ok"))!;
    const approved = (await types({ category: "APPROVAL" })).find((e) => e.entityId === actionId);
    expect(approved?.type).toBe("action.approved");
    expect(approved?.actor).toBe("user:" + t.userId);
    expect(approved?.payload).toMatchObject({ code: o.code, candidateIndex: i, actionType: c.type, verdict: c.audit.verdict });
    expect((await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, actionId)))[0].status).toBe("APPROVED");

    const prov = c.executionMode === "API_PRICELABS" ? undefined : { scope: "Portée déclarée pour le test", date: todayISO(), proof: "", externalRef: "REF-TEST-1" };
    await D.execute(t.actor, actionId, prov);
    await D.verify(t.actor, actionId);
    await D.rollback(t.actor, actionId, "Test de retour arrière");
    const trail = (await types()).filter((e) => e.entityId === actionId).map((e) => e.type).reverse();
    expect(trail).toEqual(["action.approved", "action.executed", "action.verified", "action.rolled_back"]);
    expect((await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, actionId)))[0].status).toBe("ROLLED_BACK");
    const rolled = (await types()).find((e) => e.type === "action.rolled_back" && e.entityId === actionId);
    expect(rolled?.payload).toMatchObject({ reason: "Test de retour arrière", fromStatus: "MEASURING" });
  });

  it("non-régression US-023 : une action de prix de base crée une version ACTION, son retour arrière une version ACTION_ROLLBACK", async () => {
    let pick: Awaited<ReturnType<typeof approvable>> = null;
    for (const mode of ["API_PRICELABS", "INTERNAL"]) for (const o of await open()) {
      const i = (o.candidates as Candidate[]).findIndex((c) => c.executionMode === mode && c.audit.verdict !== "REJECT" && (c.type === "BASE_PRICE_CHANGE" || c.type === "MIN_PRICE_CHANGE"));
      if (i >= 0 && !pick) pick = { o, i, c: (o.candidates as Candidate[])[i] };
    }
    if (!pick) return; // la démonstration ne propose pas toujours ce type d'action
    const { o, i, c } = pick;
    const actionId = (await D.approve(t.actor, o.id, i, D.commentRequired(c) ? "Validé après relecture du dossier." : "Ok"))!;
    await D.execute(t.actor, actionId, undefined);
    const prop = o.propertyId;
    const rows = () => db.select().from(schema.strategyVersions).where(eq(schema.strategyVersions.propertyId, prop));
    expect((await rows()).map((r) => r.source)).toContain("ACTION");
    const [act] = await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.id, actionId));
    expect((act.execution as { previousBasePriceCents?: number | null; previousMinPriceCents?: number | null }).previousBasePriceCents !== undefined).toBe(true);
    await D.rollback(t.actor, actionId, "Test de retour arrière");
    expect((await rows()).map((r) => r.source)).toContain("ACTION_ROLLBACK");
  });

  it("rejeter, différer et rouvrir un dossier écrivent chacun leur événement", async () => {
    const [a, b] = (await open()).filter((o) => !o.veto);
    await D.reject(t.actor, a.id, "Pas pertinent");
    await D.defer(t.actor, b.id, 3);
    await D.reopen(t.actor, a.id);
    const kinds = (await types()).filter((e) => e.entityId === a.id || e.entityId === b.id).map((e) => e.type);
    expect(kinds).toEqual(expect.arrayContaining(["opportunity.rejected", "opportunity.deferred", "opportunity.reopened"]));
    const rej = (await types()).find((e) => e.type === "opportunity.rejected" && e.entityId === a.id);
    expect(rej?.payload).toMatchObject({ comment: "Pas pertinent", code: a.code });
  });

  it("pas d'approbation sans sa trace : si l'audit échoue, ni action ni changement de dossier", async () => {
    const pick = (await approvable("API_PRICELABS")) ?? (await approvable("INTERNAL")) ?? (await approvable("MANUAL_RUNBOOK"));
    expect(pick).not.toBeNull();
    const { o, i, c } = pick!;
    vi.mocked(audit.recordAudit).mockImplementationOnce(async () => { throw new Error("journal indisponible"); });
    await expect(D.approve(t.actor, o.id, i, D.commentRequired(c) ? "Validé après relecture." : "")).rejects.toThrow(/journal indisponible|Failed query/);
    const [after] = await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, o.id));
    expect(after.status).toBe("OPEN");
    expect((await db.select().from(schema.revenueActions).where(eq(schema.revenueActions.opportunityId, o.id))).length).toBe(0);
    expect((await types()).some((e) => e.type === "action.approved" && (e.payload as any)?.code === o.code)).toBe(false);
  });

  it("un autre propriétaire ne peut ni approuver ni voir ce dossier, et rien n'est écrit à son nom", async () => {
    const other = await makeTenant("autre");
    const [o] = await open();
    await expect(D.approve(other.actor, o.id, 0, "Je tente")).rejects.toThrow(/introuvable/i);
    await expect(D.reject(other.actor, o.id, "non")).rejects.toThrow(/introuvable/i);
    expect((await listAuditEvents(other.tenantId)).events).toHaveLength(0);
    expect((await db.select().from(schema.opportunities).where(eq(schema.opportunities.id, o.id)))[0].status).toBe("OPEN");
  });

  it("deux décisions simultanées sur un même dossier : une seule aboutit, un seul événement", async () => {
    const o = (await open())[0];
    const before = (await types()).filter((e) => e.entityId === o.id).length;
    const r = await Promise.allSettled([D.reject(t.actor, o.id, "a"), D.reject(t.actor, o.id, "b")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(D.DecisionError);
    expect((await types()).filter((e) => e.entityId === o.id).length).toBe(before + 1);
    await expect(D.reopen(t.actor, o.id)).resolves.toBeUndefined();
    await expect(D.reopen(t.actor, o.id)).rejects.toBeInstanceOf(D.DecisionError);
  });
});
