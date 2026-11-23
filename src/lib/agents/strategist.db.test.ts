import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { startFakeLlmServer, type FakeLlmServer } from "./fake-llm-server";
import { e2eFakeReply } from "./fake-llm-responder";
import type { AgentOpinion, StrategistId } from "./strategist-opinions";
import { runDailyReview } from "../services/review";
import { seedDemo } from "../services/seed";

let srv: FakeLlmServer, t: Awaited<ReturnType<typeof makeTenant>>;
let mode: "ok" | "invent" | "rehabilitate" | "action" = "ok";
const strategist = (req: { system: string }) => req.system.includes("stratège tarifaire") || req.system.includes("responsable distribution et promotions");
const respond = (req: Parameters<typeof e2eFakeReply>[0]) => {
  if (strategist(req) && mode !== "ok") {
    const ids = Array.from(req.user.matchAll(/^(O\d{1,2}) /gm)).map((m) => m[1]);
    const rationale = mode === "invent" ? "Un gain de 987 654 € est attendu sur cette option simulée." : mode === "action" ? "Il faut baisser le prix de la nuit sur cette option simulée." : "Option simulée et jugée excellente par le stratège pour la période.";
    return JSON.stringify({ opinions: ids.map((id) => ({ option: id, stance: "FAVORABLE", rationale, watchpoints: [] })) });
  }
  return e2eFakeReply(req);
};
beforeAll(async () => { srv = await startFakeLlmServer(respond); t = await makeTenant("stratege"); await seedDemo(t.tenantId); }, 120_000);
afterAll(async () => { await srv.close(); });
beforeEach(() => { process.env.ANTHROPIC_API_BASE = srv.url; process.env.ANTHROPIC_API_KEY = "sk-ant-serveur-de-test-0123456789"; mode = "ok"; process.env.AGENT_MAX_CALLS_PER_REVIEW = "1000"; srv.requests.length = 0; });
afterEach(() => { delete process.env.ANTHROPIC_API_BASE; delete process.env.ANTHROPIC_API_KEY; delete process.env.AGENT_MAX_CALLS_PER_REVIEW; });

const open = async () => (await db.select().from(schema.opportunities).where(eq(schema.opportunities.tenantId, t.tenantId))).filter((o) => o.status === "OPEN");
const opinionsOf = (o: { signals: any }) => (o.signals?.agentOpinions ?? {}) as Partial<Record<StrategistId, AgentOpinion>>;
const expireAll = () => db.update(schema.opportunities).set({ status: "EXPIRED" }).where(eq(schema.opportunities.tenantId, t.tenantId));
const runsOf = (agent: string) => db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, t.tenantId), eq(schema.agentRuns.agentId, agent), eq(schema.agentRuns.operation, "optionOpinion")));
const decisions = async () => (await open()).map((o) => JSON.stringify({ k: o.dedupeKey, selected: o.selected, candidates: o.candidates })).sort();
const clearRuns = () => db.delete(schema.agentRuns).where(eq(schema.agentRuns.tenantId, t.tenantId));

describe("US-072 : stratèges dans la revue (base réelle, faux modèle)", () => {
  let baseline: string[];
  it("sans clé : avis par règles pour les options de chaque stratège, aucune trace", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expireAll();
    await runDailyReview(t.tenantId, "MANUAL");
    baseline = await decisions();
    const all = await open();
    expect(all.length).toBeGreaterThan(0);
    for (const o of all) for (const [agent, op] of Object.entries(opinionsOf(o))) {
      expect(op.mode).toBe("DETERMINISTIC");
      for (const it of op.items) expect((o.candidates as any[])[it.candidate].agent, `${o.code} ${agent}`).toBe(agent);
    }
    expect(await runsOf("pricing")).toHaveLength(0);
  });

  it("avec un modèle : avis LLM tracés (prompt versionné) ; options retenues, montants et audits strictement inchangés", async () => {
    await expireAll(); await clearRuns();
    await runDailyReview(t.tenantId, "MANUAL");
    const all = await open();
    const llm = all.flatMap((o) => Object.values(opinionsOf(o))).filter((op) => op.mode === "LLM");
    expect(llm.length).toBeGreaterThan(0);
    for (const op of llm) expect(op.promptVersion).toBe("2026-11-v1");
    expect(await decisions()).toEqual(baseline);
    const pr = await runsOf("pricing");
    expect(pr.length).toBeGreaterThan(0);
    expect(pr[0]).toMatchObject({ promptId: "pricing.option_opinion", provider: "anthropic", mode: "LLM" });
    // une position ne dépasse jamais le verdict de l'auditeur
    for (const o of all) for (const op of Object.values(opinionsOf(o))) for (const it of op.items) {
      const v = (o.candidates as any[])[it.candidate].audit.verdict;
      if (v === "REJECT") expect(it.stance).toBe("DEFAVORABLE");
      if (v === "NEEDS_HUMAN") expect(it.stance).not.toBe("FAVORABLE");
    }
  });

  it("faits inchangés : les avis du modèle sont conservés sans nouvel appel", async () => {
    const avant = JSON.stringify((await open()).map((o) => [o.dedupeKey, opinionsOf(o)]).sort());
    srv.requests.length = 0;
    await runDailyReview(t.tenantId, "MANUAL");
    expect(srv.requests.filter(strategist)).toHaveLength(0);
    expect(JSON.stringify((await open()).map((o) => [o.dedupeKey, opinionsOf(o)]).sort())).toBe(avant);
  });

  it.each(["invent", "rehabilitate", "action"] as const)("sortie refusée (%s) : avis par règles, trace INVALID_OUTPUT, rien d'inventé enregistré", async (m) => {
    mode = m;
    await expireAll(); await clearRuns();
    await runDailyReview(t.tenantId, "MANUAL");
    const all = await open();
    let refused = 0;
    for (const o of all) for (const op of Object.values(opinionsOf(o))) {
      // « rehabilitate » : tout est jugé favorable ; seuls les stratèges ayant une option non approuvée sont refusés (les autres avis sont légitimes)
      const hasUnapproved = op.items.some((it) => (o.candidates as any[])[it.candidate].audit.verdict !== "APPROVE");
      if (m !== "rehabilitate" || hasUnapproved) { expect(op.mode).toBe("DETERMINISTIC"); refused++; }
      for (const it of op.items) if ((o.candidates as any[])[it.candidate].audit.verdict !== "APPROVE") expect(it.stance).not.toBe("FAVORABLE");
      expect(JSON.stringify(op)).not.toContain("987");
      expect(JSON.stringify(op)).not.toContain("baisser le prix");
    }
    expect(refused).toBeGreaterThan(0);
    const runs = [...(await runsOf("pricing")), ...(await runsOf("distribution"))];
    expect(runs.filter((x) => x.mode === "DETERMINISTIC").length).toBeGreaterThan(0);
    for (const x of runs.filter((r) => r.mode === "DETERMINISTIC")) expect(x).toMatchObject({ fallbackReason: "INVALID_OUTPUT" });
    expect(await decisions()).toEqual(baseline);
  });

  it("échec récent pour les mêmes faits : pas de nouvel essai à la revue suivante", async () => {
    srv.requests.length = 0;
    await runDailyReview(t.tenantId, "MANUAL");
    expect(srv.requests.filter(strategist)).toHaveLength(0);
  });
});
