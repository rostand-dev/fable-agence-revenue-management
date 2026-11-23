import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { startFakeLlmServer, type FakeLlmServer } from "./fake-llm-server";
import { e2eFakeReply } from "./fake-llm-responder";
import type { MarketAnalysis } from "./market-analysis";
import { runDailyReview } from "../services/review";
import { seedDemo } from "../services/seed";

let srv: FakeLlmServer, t: Awaited<ReturnType<typeof makeTenant>>;
let mode: "ok" | "invent" | "action" | "unknown-evidence" = "ok";
const respond = (req: Parameters<typeof e2eFakeReply>[0]) => {
  if (req.system.includes("analyste marché") && mode !== "ok") {
    const statement = mode === "invent" ? "Le taux d'occupation du logement est de 99 % sur la période." : mode === "action" ? "Il faut baisser le prix de la nuit sur la période." : "Les pièces décrivent la situation observée sur la période.";
    return JSON.stringify({ findings: [{ statement, evidence: [mode === "unknown-evidence" ? "E42" : "E1"], confidence: "HAUTE" }], unknowns: [], hypotheses: [] });
  }
  return e2eFakeReply(req);
};
beforeAll(async () => { srv = await startFakeLlmServer(respond); t = await makeTenant("analyste"); await seedDemo(t.tenantId); }, 120_000);
afterAll(async () => { await srv.close(); });
beforeEach(() => { process.env.ANTHROPIC_API_BASE = srv.url; process.env.ANTHROPIC_API_KEY = "sk-ant-serveur-de-test-0123456789"; mode = "ok"; process.env.AGENT_MAX_CALLS_PER_REVIEW = "500"; srv.requests.length = 0; });
afterEach(() => { delete process.env.ANTHROPIC_API_BASE; delete process.env.ANTHROPIC_API_KEY; delete process.env.AGENT_MAX_CALLS_PER_REVIEW; });

const opps = () => db.select().from(schema.opportunities).where(eq(schema.opportunities.tenantId, t.tenantId));
const analysisOf = (o: { signals: any }) => o.signals?.marketAnalysis as MarketAnalysis | undefined;
const expireAll = () => db.update(schema.opportunities).set({ status: "EXPIRED" }).where(eq(schema.opportunities.tenantId, t.tenantId));
const marcheRuns = () => db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, t.tenantId), eq(schema.agentRuns.agentId, "marche"), eq(schema.agentRuns.operation, "marketFindings")));

describe("US-071 : l'analyste marché dans la revue (base réelle, faux modèle)", () => {
  it("la démonstration porte déjà une analyse par règles, avec des constats qui citent des preuves existantes", async () => {
    const all = await opps();
    expect(all.length).toBeGreaterThan(0);
    for (const o of all) {
      const a = analysisOf(o)!;
      expect(a, o.code).toBeTruthy();
      expect(a.mode).toBe("DETERMINISTIC");
      const ids = new Set(a.evidence.map((e) => e.id));
      for (const f of a.findings) for (const id of f.evidence) expect(ids.has(id), `${o.code} cite ${id}`).toBe(true);
    }
  });

  it("avec un modèle : constats LLM, preuves citées valides, trace par dossier, version du prompt", async () => {
    await expireAll();
    const r = await runDailyReview(t.tenantId, "MANUAL");
    expect(r.opened).toBeGreaterThan(0);
    const open = (await opps()).filter((o) => o.status === "OPEN");
    for (const o of open) {
      const a = analysisOf(o)!;
      expect(a.mode, o.code).toBe("LLM");
      expect(a.promptVersion).toBe("2026-11-v1");
      const ids = new Set(a.evidence.map((e) => e.id));
      expect(a.findings.length).toBeGreaterThan(0);
      for (const f of a.findings) for (const id of f.evidence) expect(ids.has(id)).toBe(true);
    }
    const runs = await marcheRuns();
    expect(runs.filter((x) => x.mode === "LLM").length).toBe(open.length);
    expect(runs[0]).toMatchObject({ promptId: "marche.market_analysis", provider: "anthropic" });
  });

  it("revue suivante, faits inchangés : l'analyse du modèle est conservée sans nouvel appel", async () => {
    const before = (await marcheRuns()).length;
    srv.requests.length = 0;
    await runDailyReview(t.tenantId, "MANUAL");
    expect(srv.requests.filter((r) => r.system.includes("analyste marché"))).toHaveLength(0);
    expect((await marcheRuns()).length).toBe(before);
    for (const o of (await opps()).filter((x) => x.status === "OPEN")) expect(analysisOf(o)!.mode).toBe("LLM");
  });

  it.each([["invent", "chiffre"], ["action", "aucune action"], ["unknown-evidence", "E42"]] as const)("sortie refusée (%s) : analyse par règles, trace du repli INVALID_OUTPUT, rien d'inventé n'est enregistré", async (m, why) => {
    mode = m;
    await expireAll();
    await db.delete(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, t.tenantId), eq(schema.agentRuns.agentId, "marche")));
    const r = await runDailyReview(t.tenantId, "MANUAL");
    expect(r.opened).toBeGreaterThan(0);
    for (const o of (await opps()).filter((x) => x.status === "OPEN")) {
      const a = analysisOf(o)!;
      expect(a.mode).toBe("DETERMINISTIC");
      expect(JSON.stringify(a)).not.toContain("99 %");
      expect(JSON.stringify(a)).not.toContain("baisser le prix");
    }
    const runs = await marcheRuns();
    expect(runs.length).toBeGreaterThan(0);
    for (const x of runs) { expect(x).toMatchObject({ mode: "DETERMINISTIC", fallbackReason: "INVALID_OUTPUT", repaired: false, attempts: 2 }); expect(String(x.error)).toBeTruthy(); }
    void why;
  });

  it("sans clé : analyse par règles et aucune trace de l'analyste", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expireAll();
    await db.delete(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, t.tenantId), eq(schema.agentRuns.agentId, "marche")));
    await runDailyReview(t.tenantId, "MANUAL");
    expect(await marcheRuns()).toHaveLength(0);
    for (const o of (await opps()).filter((x) => x.status === "OPEN")) expect(analysisOf(o)!.mode).toBe("DETERMINISTIC");
  });
});
