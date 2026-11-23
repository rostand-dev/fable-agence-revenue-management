import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { startFakeLlmServer, type FakeLlmServer } from "./fake-llm-server";
import { openBudget, runAgentTask, tokensUsedToday } from "./runner";
import { runDailyReview } from "../services/review";
import { seedDemo } from "../services/seed";

const Out = z.object({ answer: z.string().min(3) });
const NARRATIVE = JSON.stringify({ summary: "Le rythme de réservation est en retard sur le marché sur la période étudiée.", recommendation: "Retenir l'option proposée par le moteur, simulée et auditée.", caveats: ["Le montant affiché est une simulation."] });
let srv: FakeLlmServer, t: Awaited<ReturnType<typeof makeTenant>>;
const ANALYSIS = (user: string) => JSON.stringify({ findings: [{ statement: "Les pièces citées décrivent la situation observée sur la période.", evidence: [user.match(/^(E\d+) \[/m)?.[1] ?? "E1"], confidence: "MOYENNE" }], unknowns: [], hypotheses: [] });
let reply: (system: string, user: string) => string | { status: number } = (system, user) => (system.includes("analyste marché") ? ANALYSIS(user) : NARRATIVE);

beforeAll(async () => { srv = await startFakeLlmServer((req) => reply(req.system, req.user)); t = await makeTenant("runner"); }, 60_000);
afterAll(async () => { await srv.close(); });
beforeEach(() => { process.env.ANTHROPIC_API_BASE = srv.url; process.env.ANTHROPIC_API_KEY = "sk-ant-serveur-de-test-0123456789"; process.env.AGENT_MAX_CALLS_PER_REVIEW = "500"; process.env.AGENT_DAILY_TOKEN_BUDGET = "300000"; reply = (system, user) => (system.includes("analyste marché") ? ANALYSIS(user) : NARRATIVE); srv.requests.length = 0; });
afterEach(() => { for (const k of ["ANTHROPIC_API_BASE", "ANTHROPIC_API_KEY", "AGENT_MAX_CALLS_PER_REVIEW", "AGENT_DAILY_TOKEN_BUDGET"]) delete process.env[k]; });

const task = (budget: Awaited<ReturnType<typeof openBudget>>, over: Partial<Parameters<typeof runAgentTask<z.infer<typeof Out>>>[0]> = {}) => runAgentTask({
  budget, agentId: "direction", operation: "test", prompt: "direction.explain_action", user: "Faits : x", schema: Out,
  summary: ({ mode }) => `Essai ${mode}`, fallback: () => ({ answer: "repli" }), ...over,
});

describe("US-074 : exécuteur d'agent (base réelle, faux serveur de modèle)", () => {
  it("sortie valide : trace LLM complète (fournisseur, modèle, prompt, empreinte, jetons)", async () => {
    reply = () => '{"answer":"bonjour"}';
    const o = await task(await openBudget(t.tenantId));
    expect(o).toMatchObject({ mode: "LLM", reason: null, data: { answer: "bonjour" } });
    expect(o.run).toMatchObject({ mode: "LLM", provider: "anthropic", promptId: "direction.explain_action", promptVersion: "2026-11-v1", attempts: 1, repaired: false, fallbackReason: null });
    expect(o.run.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(o.run.inputTokens).toBeGreaterThan(0);
    await db.insert(schema.agentRuns).values(o.run);
    const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, o.run.id!));
    expect(row.trace).toMatchObject({ tried: [{ provider: "anthropic", outcome: "OK" }] });
  });

  it("sans aucune clé : repli déterministe NO_PROVIDER, aucun appel réseau", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const o = await task(await openBudget(t.tenantId));
    expect(o).toMatchObject({ mode: "DETERMINISTIC", reason: "NO_PROVIDER", data: { answer: "repli" } });
    expect(srv.requests).toHaveLength(0);
    expect(o.run.error).toBeNull();
  });

  it("plafond d'appels par revue : le 3e appel passe en repli BUDGET_CALLS sans appeler le modèle", async () => {
    process.env.AGENT_MAX_CALLS_PER_REVIEW = "2";
    reply = () => '{"answer":"ok ok"}';
    const b = await openBudget(t.tenantId);
    const out = [await task(b), await task(b), await task(b)];
    expect(out.map((o) => o.mode)).toEqual(["LLM", "LLM", "DETERMINISTIC"]);
    expect(out[2].reason).toBe("BUDGET_CALLS");
    expect(srv.requests).toHaveLength(2);
  });

  it("budget quotidien de jetons : les jetons déjà tracés aujourd'hui comptent, repli BUDGET_TOKENS", async () => {
    const t2 = await makeTenant("runner-jetons");
    await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: t2.tenantId, agentId: "direction", operation: "x", mode: "LLM", summary: "x", inputTokens: 600, outputTokens: 500, durationMs: 1 });
    expect(await tokensUsedToday(t2.tenantId)).toBe(1100);
    process.env.AGENT_DAILY_TOKEN_BUDGET = "1000";
    const o = await task(await openBudget(t2.tenantId));
    expect(o).toMatchObject({ mode: "DETERMINISTIC", reason: "BUDGET_TOKENS" });
    expect(srv.requests).toHaveLength(0);
    // les jetons de la veille ne comptent pas
    const t3 = await makeTenant("runner-veille");
    await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: t3.tenantId, agentId: "direction", operation: "x", mode: "LLM", summary: "x", inputTokens: 5000, outputTokens: 5000, durationMs: 1, createdAt: new Date(Date.now() - 36 * 3600_000) });
    expect(await tokensUsedToday(t3.tenantId)).toBe(0);
  });

  it("budget à 0 : aucun appel de modèle", async () => {
    process.env.AGENT_DAILY_TOKEN_BUDGET = "0";
    expect((await task(await openBudget(t.tenantId))).reason).toBe("BUDGET_TOKENS");
  });

  it("sortie inexploitable : repli INVALID_OUTPUT, trace de la correction, aucun contenu du modèle dans l'erreur", async () => {
    reply = () => "pas de json du tout sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV";
    const o = await task(await openBudget(t.tenantId));
    expect(o).toMatchObject({ mode: "DETERMINISTIC", reason: "INVALID_OUTPUT" });
    expect(o.run.attempts).toBe(2);
    expect(JSON.stringify(o.run)).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");
    expect(o.run.error).toBeTruthy();
  });

  it("fournisseur en panne (HTTP 529) : repli PROVIDER_ERROR", async () => {
    reply = () => ({ status: 529 });
    const o = await task(await openBudget(t.tenantId));
    expect(o).toMatchObject({ mode: "DETERMINISTIC", reason: "PROVIDER_ERROR" });
    expect(o.run.provider).toBe("anthropic");
  });
});

describe("US-074 : la revue passe par l'exécuteur (non-régression comprise)", () => {
  let rt: Awaited<ReturnType<typeof makeTenant>>;
  beforeAll(async () => { rt = await makeTenant("revue-llm"); await seedDemo(rt.tenantId); await db.update(schema.opportunities).set({ status: "EXPIRED" }).where(eq(schema.opportunities.tenantId, rt.tenantId)); }, 120_000);
  const runs = () => db.select().from(schema.agentRuns).where(and(eq(schema.agentRuns.tenantId, rt.tenantId), eq(schema.agentRuns.operation, "explainAction")));

  it("avec un modèle : une synthèse tracée par dossier ouvert, le dossier porte la version du prompt", async () => {
    const r = await runDailyReview(rt.tenantId, "MANUAL");
    expect(r.opened).toBeGreaterThan(0);
    const rows = await runs();
    expect(rows.length).toBe(r.opened);
    expect(rows.every((x) => x.createdAt <= new Date())).toBe(true);
    for (const x of rows) expect(x).toMatchObject({ mode: "LLM", provider: "anthropic", promptId: "direction.explain_action", promptVersion: "2026-11-v1" });
    const opened = await db.select().from(schema.opportunities).where(and(eq(schema.opportunities.tenantId, rt.tenantId), eq(schema.opportunities.status, "OPEN")));
    expect(opened.some((o) => o.narrative?.mode === "LLM" && o.narrative?.promptVersion === "2026-11-v1")).toBe(true);
  });

  it("plafond de 2 appels pour la revue : le premier dossier (analyse + synthèse) les consomme, les autres synthèses sont en repli tracé", async () => {
    process.env.AGENT_MAX_CALLS_PER_REVIEW = "2";
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.tenantId, rt.tenantId));
    await db.update(schema.opportunities).set({ status: "EXPIRED" }).where(eq(schema.opportunities.tenantId, rt.tenantId));
    const r = await runDailyReview(rt.tenantId, "MANUAL");
    expect(r.opened, "la démonstration doit ouvrir au moins deux dossiers pour que le plafond se voie").toBeGreaterThanOrEqual(2);
    const rows = await runs();
    expect(rows.filter((x) => x.mode === "LLM")).toHaveLength(1);
    expect(rows.filter((x) => x.fallbackReason === "BUDGET_CALLS").length).toBe(r.opened - 1);
  });

  it("sans clé : aucune trace de modèle, synthèse par règles (comportement des épics précédents)", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await db.delete(schema.agentRuns).where(eq(schema.agentRuns.tenantId, rt.tenantId));
    await db.update(schema.opportunities).set({ status: "EXPIRED" }).where(eq(schema.opportunities.tenantId, rt.tenantId));
    const r = await runDailyReview(rt.tenantId, "MANUAL");
    expect(r.opened).toBeGreaterThan(0);
    expect(await runs()).toHaveLength(0);
  });
});
