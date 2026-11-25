import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { setOwnerKey } from "@/test/llm-keys";
import { startFakeLlmServer, type FakeLlmServer } from "./fake-llm-server";
import { e2eFakeReply } from "./fake-llm-responder";
import type { IndependentReview } from "./independent-review";
import { runDailyReview } from "../services/review";
import { seedDemo } from "../services/seed";

let srv: FakeLlmServer, t: Awaited<ReturnType<typeof makeTenant>>;
let mode: "ok" | "concern" | "invent" = "ok";
const isAuditor = (req: { system: string }) => req.system.includes("auditeur indépendant");
const respond = (req: Parameters<typeof e2eFakeReply>[0]) => {
  if (isAuditor(req) && mode !== "ok") {
    const id = /^(E\d{1,2}) \[/m.exec(req.user)?.[1] ?? "E1";
    return JSON.stringify({ concern: true, reason: mode === "invent" ? "L'écart de 987 654 € annoncé n'est pas établi par les pièces." : "Les pièces citées ne soutiennent pas clairement l'option retenue.", evidence: [id] });
  }
  return e2eFakeReply(req);
};
beforeAll(async () => { srv = await startFakeLlmServer(respond); t = await makeTenant("auditeur"); await seedDemo(t.tenantId); }, 120_000);
afterAll(async () => { await srv.close(); });
beforeEach(async () => { process.env.ANTHROPIC_API_BASE = srv.url; await setOwnerKey(t.tenantId); mode = "ok"; process.env.AGENT_MAX_CALLS_PER_REVIEW = "1000"; srv.requests.length = 0; });
afterEach(() => { delete process.env.ANTHROPIC_API_BASE; delete process.env.AGENT_MAX_CALLS_PER_REVIEW; });

const open = async () => (await db.select().from(schema.opportunities).where(eq(schema.opportunities.tenantId, t.tenantId))).filter((o) => o.status === "OPEN");
const reviewOf = (o: { signals: any }) => o.signals?.independentReview as IndependentReview | undefined;
const expireAll = () => db.update(schema.opportunities).set({ status: "EXPIRED" }).where(eq(schema.opportunities.tenantId, t.tenantId));
const clearRuns = () => db.delete(schema.agentRuns).where(eq(schema.agentRuns.tenantId, t.tenantId));
const runs = () => db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, t.tenantId), eq(schema.agentRuns.agentId, "audit"), eq(schema.agentRuns.operation, "independentReview")));
const sel = (o: { candidates: unknown; selected: number }) => (o.candidates as any[])[o.selected];
/** Tout sauf l'audit de l'option retenue : montants, options, option retenue. */
const decisions = async () => (await open()).map((o) => JSON.stringify({ k: o.dedupeKey, selected: o.selected, c: (o.candidates as any[]).map((c) => ({ ...c, audit: undefined })) })).sort();
const verdicts = async () => (await open()).map((o) => JSON.stringify([o.dedupeKey, (o.candidates as any[]).map((c) => c.audit.verdict)])).sort();

describe("US-073 : seconde lecture indépendante dans la revue (base réelle, faux modèle)", () => {
  let baseDecisions: string[], baseVerdicts: string[];
  it("sans clé : aucune seconde lecture, aucun changement de verdict", async () => {
    await setOwnerKey(t.tenantId, null);
    await expireAll();
    await runDailyReview(t.tenantId, "MANUAL");
    baseDecisions = await decisions(); baseVerdicts = await verdicts();
    expect(baseVerdicts.length).toBeGreaterThan(0);
    for (const o of await open()) expect(reviewOf(o)).toBeUndefined();
    expect(await runs()).toHaveLength(0);
  });

  it("sans réserve : trace LLM, avis consigné, verdicts strictement inchangés", async () => {
    await expireAll(); await clearRuns();
    await runDailyReview(t.tenantId, "MANUAL");
    const reviewed = (await open()).filter((o) => reviewOf(o));
    expect(reviewed.length).toBeGreaterThan(0);
    for (const o of reviewed) expect(reviewOf(o)).toMatchObject({ mode: "LLM", concern: false, promptVersion: "2026-11-v1" });
    expect((await runs())[0]).toMatchObject({ promptId: "audit.independent_review", provider: "anthropic", mode: "LLM" });
    expect(await verdicts()).toEqual(baseVerdicts);
    expect(await decisions()).toEqual(baseDecisions);
  });

  it("l'auditeur ne reçoit ni verdict des règles ni avis des autres postes", async () => {
    await expireAll(); await clearRuns(); srv.requests.length = 0;
    await runDailyReview(t.tenantId, "MANUAL");
    const calls = srv.requests.filter(isAuditor);
    expect(calls.length).toBeGreaterThan(0);
    for (const r of calls) expect(r.user).not.toMatch(/\b(APPROVE|NEEDS_HUMAN|REJECT)\b|verdict de l.auditeur|Synthèse du dossier/);
  });

  it("avec réserve : INDEPENDENT_REVIEW ajoutée à l'option retenue approuvée seulement ; rejets, montants et option retenue intacts", async () => {
    mode = "concern";
    await expireAll(); await clearRuns();
    await runDailyReview(t.tenantId, "MANUAL");
    const all = await open();
    let alerted = 0;
    for (const o of all) {
      const rev = reviewOf(o), c = sel(o);
      if (!rev) continue;
      const has = c.audit.rules.some((r: any) => r.code === "INDEPENDENT_REVIEW");
      expect(has, o.code).toBe(rev.concern && rev.reviewed === c.label && c.audit.verdict !== "REJECT" && c.type !== "NO_ACTION");
      if (has) { alerted++; expect(c.audit.verdict).toBe("NEEDS_HUMAN"); expect(c.audit.humanCodes).toContain("INDEPENDENT_REVIEW"); }
      // aucun veto n'a été levé : les rejets restent des rejets, sur toutes les options
      for (const x of o.candidates as any[]) if (x.audit.rules.some((r: any) => r.outcome === "FAIL")) expect(x.audit.verdict).toBe("REJECT");
    }
    expect(alerted).toBeGreaterThan(0);
    expect(await decisions()).toEqual(baseDecisions);
    // seuls les verdicts APPROUVE de l'option retenue ont pu devenir À VALIDER ; aucun REJETÉ n'a changé
    const after = new Map((await open()).map((o) => [o.dedupeKey, (o.candidates as any[]).map((c) => c.audit.verdict)]));
    for (const line of baseVerdicts) { const [k, vs] = JSON.parse(line) as [string, string[]]; vs.forEach((v, i) => { if (v === "REJECT") expect(after.get(k)![i]).toBe("REJECT"); }); }
  });

  it("faits inchangés : la réserve est conservée et ré-appliquée sans nouvel appel", async () => {
    const avant = await verdicts();
    srv.requests.length = 0;
    await runDailyReview(t.tenantId, "MANUAL");
    expect(srv.requests.filter(isAuditor)).toHaveLength(0);
    expect(await verdicts()).toEqual(avant);
  });

  it("sortie refusée (chiffre inventé) : aucune réserve enregistrée, trace INVALID_OUTPUT, verdicts inchangés", async () => {
    mode = "invent";
    await expireAll(); await clearRuns();
    await runDailyReview(t.tenantId, "MANUAL");
    // le montant inventé entier, pas « 987 » seul : les millisecondes d'un horodatage de la trace peuvent le contenir
    for (const o of await open()) { const r = reviewOf(o); if (r) { expect(r.mode).toBe("DETERMINISTIC"); expect(r.concern).toBe(false); expect(JSON.stringify(r)).not.toMatch(/987\s?654/); } }
    const rs = await runs();
    expect(rs.length).toBeGreaterThan(0);
    for (const x of rs) expect(x).toMatchObject({ mode: "DETERMINISTIC", fallbackReason: "INVALID_OUTPUT" });
    expect(await verdicts()).toEqual(baseVerdicts);
  });
});
