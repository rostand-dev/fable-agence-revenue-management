import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { todayISO } from "../dates";
import { reviewProperty } from "../engine/detect";
import { PLAYBOOKS } from "../engine/playbooks";
import * as D from "./decisions";
import { loadEngineInput, runDailyReview } from "./review";
import { seedDemo } from "./seed";
import type { Candidate } from "../engine/types";

const { opportunities, revenueActions, properties } = schema;
let t: Awaited<ReturnType<typeof makeTenant>>;
let evryId: string;
beforeAll(async () => {
  t = await makeTenant("structurel");
  await seedDemo(t.tenantId);
  const props = await db.select().from(properties).where(eq(properties.tenantId, t.tenantId));
  evryId = props.find((p) => /vry/i.test(p.name))!.id;
}, 120_000);

const today = () => todayISO(new Date());
async function baseAction(status: string, changePct = 5, approvedDaysAgo = 1) {
  const oppId = newId("opp"), id = newId("act");
  await db.insert(opportunities).values({ id: oppId, tenantId: t.tenantId, propertyId: evryId, code: "S-" + oppId.slice(-6), playbook: "TEST", reasonCode: "TEST", title: "Dossier de test", stayFrom: today(), stayTo: today(), dedupeKey: oppId, signals: {}, diagnosis: {}, candidates: [], status: "DECIDED", expiresAt: "2099-01-01" });
  await db.insert(revenueActions).values({ id, tenantId: t.tenantId, propertyId: evryId, opportunityId: oppId, type: "BASE_PRICE_CHANGE", label: "Prix de base", target: { system: "PRICELABS" }, parameters: { changePct }, simulation: {}, audit: {}, status: "DRAFT", riskLevel: "HIGH", rollbackPlan: "test", idempotencyKey: id });
  for (const st of ["SIMULATED", "AUDITED", "PENDING_APPROVAL", "APPROVED", ...(status === "APPROVED" ? [] : ["EXECUTING", "EXECUTED", "VERIFIED", "MEASURING", "CLOSED"].slice(0, ["EXECUTING", "EXECUTED", "VERIFIED", "MEASURING", "CLOSED"].indexOf(status) + 1))]) await db.update(revenueActions).set({ status: st }).where(eq(revenueActions.id, id));
  await db.update(revenueActions).set({ approvedAt: new Date(Date.now() - approvedDaysAgo * 86400000) }).where(eq(revenueActions.id, id));
  return id;
}
const clearBase = () => db.delete(revenueActions).where(and(eq(revenueActions.tenantId, t.tenantId), eq(revenueActions.type, "BASE_PRICE_CHANGE")));
const baseCandidate = async () => {
  const input = (await loadEngineInput(t.tenantId, evryId, today()))!;
  const opp = reviewProperty(input).opportunities.find((o) => o.playbook === "PB-02");
  return { input, cand: opp?.candidates.find((c: Candidate) => c.type === "BASE_PRICE_CHANGE") };
};

describe("garde-fous structurants du prix de base, sur une base réelle", () => {
  it("sans action de prix de base, le levier est libre et l'option passe les deux règles", async () => {
    const { input, cand } = await baseCandidate();
    expect(input.structuralHold).toBeNull();
    expect(input.recentBaseChanges).toEqual([]);
    expect(cand, "la démonstration d'Évry doit proposer une hausse du prix de base (PB-02)").toBeTruthy();
    expect(cand!.audit.rules.find((r) => r.code === "STRUCTURAL_LOCK")?.outcome).toBe("PASS");
    expect(cand!.audit.rules.find((r) => r.code === "MAX_VARIATION_7D")?.outcome).toBe("PASS");
  });

  it("une action de prix de base en observation verrouille le levier : l'option est rejetée avec le code du veto", async () => {
    const id = await baseAction("MEASURING", 5);
    const { input, cand } = await baseCandidate();
    expect(input.structuralHold).toMatchObject({ reason: "ACTION_ACTIVE" });
    expect(cand!.audit.verdict).toBe("REJECT");
    expect(cand!.audit.vetoCodes).toContain("STRUCTURAL_LOCK");
    await db.delete(revenueActions).where(eq(revenueActions.id, id));
  });

  it("une action clôturée libère le verrou mais compte encore dans le plafond de 7 jours", async () => {
    await clearBase();
    await baseAction("CLOSED", 12, 2);
    const { input, cand } = await baseCandidate();
    expect(input.structuralHold).toBeNull();
    expect(input.recentBaseChanges).toHaveLength(1);
    // 12 % déjà passés + 5 % proposés = 17 % cumulés, au-delà du plafond de 15 %
    expect(cand!.audit.vetoCodes).toContain("MAX_VARIATION_7D");
    await clearBase();
  });

  it("au-delà de 7 jours, la variation ne compte plus", async () => {
    await baseAction("CLOSED", 12, 9);
    const { input, cand } = await baseCandidate();
    expect(input.recentBaseChanges).toEqual([]);
    expect(cand!.audit.rules.find((r) => r.code === "MAX_VARIATION_7D")?.outcome).toBe("PASS");
    await clearBase();
  });
});

describe("contrôle à l'approbation", () => {
  it("un dossier détecté avant une autre approbation ne contourne pas le verrou : l'approbation est refusée", async () => {
    await clearBase();
    const open = (await db.select().from(opportunities).where(and(eq(opportunities.propertyId, evryId), eq(opportunities.playbook, "PB-02"), eq(opportunities.status, "OPEN"))))[0];
    expect(open, "dossier PB-02 ouvert attendu").toBeTruthy();
    const idx = (open.candidates as Candidate[]).findIndex((c) => c.type === "BASE_PRICE_CHANGE");
    expect(idx).toBeGreaterThanOrEqual(0);
    // la détection a vu un levier libre ; entre-temps une autre modification du prix de base est approuvée
    const other = await baseAction("APPROVED", 5, 0);
    await expect(D.approve(t.actor, open.id, idx, "Hausse du prix de base sur la demande lointaine.")).rejects.toThrow(/déjà en cours/);
    await db.delete(revenueActions).where(eq(revenueActions.id, other));
    // le plafond cumulé est aussi revérifié
    await baseAction("CLOSED", 12, 2);
    await expect(D.approve(t.actor, open.id, idx, "Hausse du prix de base sur la demande lointaine.")).rejects.toThrow(/plafond de 15 %/);
    await clearBase();
  });
});

describe("groupe de repos PB-02, PB-11, PB-12 dans la revue", () => {
  it("une décision sur PB-12 empêche la réouverture de PB-02 pendant son repos, puis la laisse revenir", async () => {
    await clearBase();
    const open = await db.select().from(opportunities).where(and(eq(opportunities.propertyId, evryId), eq(opportunities.playbook, "PB-02")));
    expect(open.length, "la démonstration d'Évry doit avoir un dossier PB-02").toBeGreaterThan(0);
    // un dossier PB-12 tranché hier (copie d'un dossier existant : mêmes colonnes obligatoires)
    const { id: _id, code: _code, ...rest } = open[0];
    const twelve = newId("opp");
    await db.insert(opportunities).values({ ...rest, id: twelve, code: "G-" + twelve.slice(-6), playbook: "PB-12", dedupeKey: `${evryId}|PB-12|x`, status: "DECIDED", decision: "APPROVED", decidedAt: new Date(Date.now() - 86400000), groupKey: null, deferUntil: null });
    // le dossier PB-02 existant expire : seul un nouveau dossier pourrait le remplacer
    await db.update(opportunities).set({ status: "EXPIRED" }).where(and(eq(opportunities.propertyId, evryId), eq(opportunities.playbook, "PB-02")));
    const run = await runDailyReview(t.tenantId, "MANUAL");
    expect(run.resting, "le signal PB-02 doit être compté en repos : la revue l'a vu et l'a laissé fermé").toBeGreaterThanOrEqual(1);
    const during = await db.select().from(opportunities).where(and(eq(opportunities.propertyId, evryId), eq(opportunities.playbook, "PB-02"), eq(opportunities.status, "OPEN")));
    expect(during, "PB-02 doit rester au repos tant que PB-12 est en repos").toHaveLength(0);
    // la période écoulée, PB-02 rouvre
    await db.update(opportunities).set({ decidedAt: new Date(Date.now() - (PLAYBOOKS["PB-12"].cooldownDays + 2) * 86400000) }).where(eq(opportunities.id, twelve));
    await runDailyReview(t.tenantId, "MANUAL");
    const after = await db.select().from(opportunities).where(and(eq(opportunities.propertyId, evryId), eq(opportunities.playbook, "PB-02"), eq(opportunities.status, "OPEN")));
    expect(after).toHaveLength(1);
  });
});
