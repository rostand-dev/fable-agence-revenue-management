import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { setOwnerKey } from "@/test/llm-keys";
import { startFakeLlmServer, type FakeLlmServer } from "../agents/fake-llm-server";
import { scriptedProvider } from "../agents/gateway";
import { resolveRouting } from "../agents/llm-config";
import { openBudget, runAgentTask } from "../agents/runner";
import { benchCases, benchVerdict, estimateBenchCostUsd, runBench, suspendFromObserved, tasksFor, BENCH_TASKS, MAX_CASES_PER_TASK } from "./bench";
import { capState, getCapState, setMonthlyCapEur } from "./cap";
import { invalidatePriceBook } from "./pricebook";
import { runObservedSuspension } from "./job";
import { seedCatalog, syncPrices } from "./sync";

const NOW = new Date();
const LITELLM = {
  "claude-haiku-5-5": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  "claude-sonnet-5-5": { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
  "gpt-6-luna": { input_cost_per_token: 2e-7, output_cost_per_token: 1.6e-6 },
  "gpt-6.1-terra": { input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5 },
  "mistral/mistral-small-2603": { input_cost_per_token: 1e-7, output_cost_per_token: 3e-7 },
};
const priceFetch = (async (u: string | URL) => (String(u).includes("model_prices") ? new Response(JSON.stringify(LITELLM)) : new Response("{}", { status: 404 }))) as unknown as typeof fetch;
const ALL = ["claude-haiku-5-5", "gpt-6-luna", "mistral-small-2603", "gpt-6.1-terra", "claude-sonnet-5-5"];

async function setup() {
  await db.delete(schema.llmPriceSnapshots); await db.delete(schema.llmModels); invalidatePriceBook();
  await seedCatalog();
  await syncPrices({ fetchImpl: priceFetch, now: NOW, env: {}, keys: async () => ({}) });
  await db.update(schema.llmModels).set({ lifecycle: "ACTIVE" });
  invalidatePriceBook();
}
const qualify = (ids: string[], task: string, score = "0.9700") => db.insert(schema.llmQualifications).values(ids.map((modelId) => ({ modelId, task, status: "QUALIFIED", benchScore: score, benchCases: 8 }))).onConflictDoNothing();

describe("routage avec les clés du propriétaire (base réelle)", () => {
  beforeEach(setup);
  afterEach(() => { for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAI_MODEL", "MISTRAL_API_KEY"]) delete process.env[k]; });

  it("sans clé du propriétaire : aucune cible, même si une clé existe dans l'environnement du serveur (aucune clé serveur n'est utilisée)", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-serveur-0123456789"; process.env.OPENAI_API_KEY = "sk-openai-serveur-0123456789"; process.env.OPENAI_MODEL = "gpt-6-luna";
    const t = await makeTenant("sans-cle");
    const r = await resolveRouting(t.tenantId, "direction");
    expect(r.targets).toEqual([]);
    expect(r.reason).toBe("aucune_cle");
  });

  it("démarrage sans régression : aucun modèle qualifié = ANTHROPIC_MODEL avec la clé Anthropic du propriétaire", async () => {
    const t = await makeTenant("demarrage"); await setOwnerKey(t.tenantId);
    const r = await resolveRouting(t.tenantId, "direction");
    expect(r.reason).toBe("demarrage_sans_regression");
    expect(r.targets.map((x) => [x.provider.id, x.model, x.source, x.apiKey])).toEqual([["anthropic", "claude-sonnet-5-5", "utilisateur", "sk-ant-proprietaire-de-test-0123456789"]]);
    expect(r.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("le moins cher qui convient parmi les fournisseurs du propriétaire, chaque cible avec SA clé ; un fournisseur sans clé n'est jamais utilisé", async () => {
    const t = await makeTenant("auto");
    await setOwnerKey(t.tenantId, "sk-ant-proprietaire-de-test-0123456789"); await setOwnerKey(t.tenantId, "sk-openai-proprietaire-0123456789", "openai", ["gpt-6-luna", "gpt-6.1-terra"]);
    await qualify(ALL, "direction.explain_action");
    const r = await resolveRouting(t.tenantId, "direction");
    expect(r.reason).toBe("auto_moins_cher");
    expect(r.targets.map((x) => [x.provider.id, x.model, x.apiKey])).toEqual([
      ["openai", "gpt-6-luna", "sk-openai-proprietaire-0123456789"], ["openai", "gpt-6.1-terra", "sk-openai-proprietaire-0123456789"], ["anthropic", "claude-sonnet-5-5", "sk-ant-proprietaire-de-test-0123456789"],
    ]);
    expect(r.targets.map((x) => x.model)).not.toContain("mistral-small-2603");
  });

  it("le choix manuel d'un agent prime toujours, et ne concerne que cet agent", async () => {
    const t = await makeTenant("manuel"); await setOwnerKey(t.tenantId); await qualify(ALL, "direction.explain_action"); await qualify(ALL, "marche.market_analysis");
    await db.update(schema.tenants).set({ settings: { agentModels: { direction: "claude-sonnet-5-5" } } }).where(eq(schema.tenants.id, t.tenantId));
    expect(await resolveRouting(t.tenantId, "direction")).toMatchObject({ reason: "choix_manuel", chosen: [{ modelId: "claude-sonnet-5-5" }] });
    expect((await resolveRouting(t.tenantId, "marche")).reason).toBe("auto_moins_cher");
  });

  it("Victor (audit) n'est jamais rétrogradé en automatique : modèle premium seulement", async () => {
    const t = await makeTenant("victor"); await setOwnerKey(t.tenantId); await qualify(ALL, "audit.independent_review");
    const r = await resolveRouting(t.tenantId, "audit");
    expect(r.chosen.map((c) => [c.modelId, c.tier])).toEqual([["claude-sonnet-5-5", "premium"]]);
  });

  it("un modèle retiré, absent ou sans prix est exclu", async () => {
    const t = await makeTenant("exclus"); await setOwnerKey(t.tenantId); await qualify(ALL, "direction.explain_action");
    await db.update(schema.llmModels).set({ lifecycle: "RETIRED" }).where(eq(schema.llmModels.modelId, "claude-haiku-5-5"));
    await db.delete(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.modelId, "claude-sonnet-5-5")); invalidatePriceBook();
    // plus aucun modèle Anthropic routable : démarrage sans régression (le modèle par défaut, avec la clé du propriétaire)
    const r = await resolveRouting(t.tenantId, "direction");
    expect(r.chosen.map((c) => c.modelId)).not.toContain("claude-haiku-5-5");
    expect(r.reason).toBe("demarrage_sans_regression");
  });

  it("un modèle suspendu n'est plus candidat", async () => {
    const t = await makeTenant("suspendu"); await setOwnerKey(t.tenantId);
    await qualify(["claude-haiku-5-5", "claude-sonnet-5-5"], "direction.explain_action");
    await db.update(schema.llmQualifications).set({ status: "SUSPENDED" }).where(eq(schema.llmQualifications.modelId, "claude-haiku-5-5"));
    expect((await resolveRouting(t.tenantId, "direction")).chosen.map((c) => c.modelId)).toEqual(["claude-sonnet-5-5"]);
  });

  it("le chat : modèle économique, une seule cible, Anthropic seulement", async () => {
    const t = await makeTenant("chat"); await setOwnerKey(t.tenantId); await setOwnerKey(t.tenantId, "sk-openai-proprietaire-0123456789", "openai", ["gpt-6-luna"]);
    await qualify(ALL, "direction.explain_action");
    const r = await resolveRouting(t.tenantId, "direction", { task: "chat" });
    expect(r.targets.map((x) => [x.provider.id, x.model])).toEqual([["anthropic", "claude-haiku-5-5"]]);
  });
});

describe("plafond mensuel en euros (base réelle, faux serveur de modèle)", () => {
  let srv: FakeLlmServer;
  const Out = z.object({ answer: z.string().min(3) });
  beforeAll(async () => { srv = await startFakeLlmServer(() => '{"answer":"bonjour"}'); });
  afterAll(async () => { await srv.close(); });
  beforeEach(async () => { await setup(); process.env.ANTHROPIC_API_BASE = srv.url; srv.requests.length = 0; });
  afterEach(() => { delete process.env.ANTHROPIC_API_BASE; });
  const run = async (tenantId: string) => runAgentTask({ budget: await openBudget(tenantId), agentId: "direction", operation: "test", prompt: "direction.explain_action", user: "Faits : x", schema: Out, summary: ({ mode }) => `Essai ${mode}`, fallback: () => ({ answer: "repli" }) });
  const spend = (tenantId: string, usd: number, at = new Date()) => db.insert(schema.agentRuns).values({ id: newId("run"), tenantId, agentId: "direction", operation: "x", mode: "LLM", summary: "x", durationMs: 1, costUsd: String(usd), createdAt: at });

  it("sans plafond (défaut) : les appels se font ; le coût estimé puis réel est tracé", async () => {
    const t = await makeTenant("sans-plafond"); await setOwnerKey(t.tenantId);
    const o = await run(t.tenantId);
    expect(o.mode).toBe("LLM");
    expect(Number(o.run.costEstimatedUsd)).toBeGreaterThan(0);
    expect(Number(o.run.costUsd)).toBeGreaterThan(0);
    expect((o.run.trace as any).route).toMatchObject({ reason: "demarrage_sans_regression" });
  });

  it("plafond atteint : plus aucun appel de modèle, repli déterministe BUDGET_CAP tracé, sans erreur", async () => {
    const t = await makeTenant("plafond-atteint"); await setOwnerKey(t.tenantId); await setMonthlyCapEur(t.tenantId, 1);
    await spend(t.tenantId, 2); // 2 USD ≈ 1,84 € > 1 €
    const o = await run(t.tenantId);
    expect(o).toMatchObject({ mode: "DETERMINISTIC", reason: "BUDGET_CAP", data: { answer: "repli" } });
    expect(o.run.error).toBeNull();
    expect(srv.requests).toHaveLength(0);
    expect((await resolveRouting(t.tenantId, "direction")).reason).toBe("plafond_mensuel");
    expect((await getCapState(t.tenantId)).level).toBe("reached");
  });

  it("le plafond se remet à zéro au mois suivant : la dépense du mois précédent ne compte pas", async () => {
    const t = await makeTenant("plafond-mois"); await setOwnerKey(t.tenantId); await setMonthlyCapEur(t.tenantId, 1);
    const now = new Date(), lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86400_000);
    await spend(t.tenantId, 50, lastMonth);
    expect((await getCapState(t.tenantId)).level).toBe("ok");
    expect((await run(t.tenantId)).mode).toBe("LLM");
  });

  it("alerte à 80 % puis atteint à 100 % (calcul pur, taux fixe)", () => {
    expect(capState(null, 99).level).toBe("none");
    expect(capState(10, 0, 1).level).toBe("ok");
    expect(capState(10, 7.9, 1).level).toBe("ok");
    expect(capState(10, 8, 1).level).toBe("alert");
    expect(capState(10, 9.99, 1).level).toBe("alert");
    expect(capState(10, 10, 1).level).toBe("reached");
    expect(capState(100, 50, 0.9)).toMatchObject({ spentEur: 45, level: "ok" });
  });

  it("clé du propriétaire refusée (401) : repli déterministe, et seule SA clé a été envoyée au fournisseur", async () => {
    await srv.close(); srv = await startFakeLlmServer(() => ({ status: 401 })); process.env.ANTHROPIC_API_BASE = srv.url;
    process.env.ANTHROPIC_API_KEY = "sk-ant-serveur-ne-doit-jamais-servir";
    try {
      const t = await makeTenant("cle-refusee"); await setOwnerKey(t.tenantId);
      const o = await run(t.tenantId);
      expect(o).toMatchObject({ mode: "DETERMINISTIC", reason: "PROVIDER_ERROR" });
      expect(srv.requests.length).toBeGreaterThan(0);
      expect(srv.requests.every((r) => r.apiKey === "sk-ant-proprietaire-de-test-0123456789")).toBe(true);
    } finally { delete process.env.ANTHROPIC_API_KEY; }
  });
});

describe("banc d'évaluation et suspension (base réelle)", () => {
  beforeEach(setup);

  it("les cas sont synthétiques, bornés et couvrent chaque tâche ; un modèle n'est testé que sur les tâches de son niveau", () => {
    for (const task of BENCH_TASKS) { const c = benchCases(task); expect(c.length).toBeGreaterThan(0); expect(c.length).toBeLessThanOrEqual(MAX_CASES_PER_TASK); }
    expect(tasksFor("claude-haiku-5-5")).not.toContain("audit.independent_review");
    expect(tasksFor("claude-sonnet-5-5")).toContain("audit.independent_review");
    expect(tasksFor("inconnu")).toEqual([]);
    expect(benchVerdict(8, 8).status).toBe("QUALIFIED");
    expect(benchVerdict(19, 20).status).toBe("QUALIFIED"); // 95 %
    expect(benchVerdict(7, 8).status).toBe("SUSPENDED");
    expect(benchVerdict(0, 0).status).toBe("SUSPENDED");
  });

  it("coût estimé du banc affiché avant le clic : calculé au prix validé, nul si le prix est inconnu", async () => {
    const e = await estimateBenchCostUsd("claude-haiku-5-5");
    expect(e.calls).toBeGreaterThan(0);
    expect(e.costUsd).toBeGreaterThan(0);
    await db.delete(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.modelId, "gpt-6-luna")); invalidatePriceBook();
    expect((await estimateBenchCostUsd("gpt-6-luna")).costUsd).toBeNull();
  });

  it("modèle fiable : qualifié sur chaque tâche testée, résultat partagé en base", async () => {
    const { e2eFakeReply } = await import("../agents/fake-llm-responder");
    const p = scriptedProvider((req) => { const r = e2eFakeReply({ system: req.system, user: req.user, body: {} } as never); return typeof r === "string" ? r : JSON.stringify(r); });
    const out = await runBench({ modelId: "claude-haiku-5-5", apiKey: "cle-banc", evaluatedBy: "usr_test", provider: p });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results.map((r) => r.task).sort()).toEqual(tasksFor("claude-haiku-5-5").sort());
    expect(out.results.every((r) => r.status === "QUALIFIED" && r.ok === r.total)).toBe(true);
    const rows = await db.select().from(schema.llmQualifications).where(eq(schema.llmQualifications.modelId, "claude-haiku-5-5"));
    expect(rows.length).toBe(out.results.length);
    expect(rows.every((r) => r.status === "QUALIFIED" && Number(r.benchScore) === 1 && r.evaluatedBy === "usr_test")).toBe(true);
    // données personnelles : les cas sont des logements de démonstration, la clé n'est jamais conservée
    expect(JSON.stringify(rows)).not.toContain("cle-banc");
  });

  it("modèle peu fiable : suspendu, avec la raison ; un nouveau banc réussi le requalifie", async () => {
    const bad = scriptedProvider(() => "ceci n'est pas du JSON");
    const out = await runBench({ modelId: "claude-haiku-5-5", apiKey: "k", evaluatedBy: "usr_test", provider: bad });
    expect(out.ok && out.results.every((r) => r.status === "SUSPENDED")).toBe(true);
    const [row] = await db.select().from(schema.llmQualifications).where(eq(schema.llmQualifications.modelId, "claude-haiku-5-5"));
    expect(row.status).toBe("SUSPENDED");
    expect(row.reason).toContain("banc insuffisant");
  });

  it("panne du fournisseur pendant le banc (clé refusée, réseau) : interrompu, rien d'enregistré, pas de faux échec du modèle", async () => {
    const { LlmError } = await import("../agents/llm");
    const down = scriptedProvider(() => new LlmError("Clé API refusée par Anthropic.", 401));
    const out = await runBench({ modelId: "claude-haiku-5-5", apiKey: "k", evaluatedBy: "usr_test", provider: down });
    expect(out).toMatchObject({ ok: false });
    expect(out.ok ? "" : out.error).toContain("Aucun résultat enregistré");
    expect((await db.select().from(schema.llmQualifications)).length).toBe(0);
  });

  it("suspension sur échecs observés : sous 95 % sur 30 jours avec assez d'appels ; les pannes ne comptent pas ; repart de zéro après un nouveau banc", async () => {
    const t = await makeTenant("observe");
    await qualify(["claude-haiku-5-5"], "direction.explain_action");
    const [q] = await db.select().from(schema.llmQualifications).where(eq(schema.llmQualifications.modelId, "claude-haiku-5-5"));
    await db.update(schema.llmQualifications).set({ evaluatedAt: new Date(Date.now() - 10 * 86400_000) }).where(eq(schema.llmQualifications.modelId, q.modelId));
    const add = (n: number, outcome: string) => db.insert(schema.agentRuns).values(Array.from({ length: n }, () => ({ id: newId("run"), tenantId: t.tenantId, agentId: "direction", operation: "explainAction", mode: "LLM", summary: "x", durationMs: 1, promptId: "direction.explain_action", trace: { tried: [{ provider: "anthropic", model: "claude-haiku-5-5", outcome }] } })));
    await add(18, "OK"); await add(1, "SCHEMA");
    expect(await suspendFromObserved()).toEqual([]); // 19 appels : pas assez pour conclure
    await add(10, "PROVIDER_ERROR");
    expect(await suspendFromObserved()).toEqual([]); // les pannes ne comptent ni pour ni contre
    await add(2, "INVALID_JSON"); // 18 sur 21 = 85,7 %
    const s = await suspendFromObserved();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ modelId: "claude-haiku-5-5", task: "direction.explain_action" });
    const [after] = await db.select().from(schema.llmQualifications).where(and(eq(schema.llmQualifications.modelId, "claude-haiku-5-5")));
    expect(after).toMatchObject({ status: "SUSPENDED", evaluatedBy: "system" });
    expect(after.reason).toContain("échecs observés");
    // requalifié par un nouveau banc : les anciens échecs ne le re-suspendent pas
    await db.update(schema.llmQualifications).set({ status: "QUALIFIED", evaluatedAt: new Date(), evaluatedBy: "usr_test" }).where(eq(schema.llmQualifications.modelId, "claude-haiku-5-5"));
    expect(await suspendFromObserved()).toEqual([]);
  });

  it("la passe horaire est coupée avec le job (LLM_SYNC_INTERVAL_HOURS=0)", async () => {
    process.env.LLM_SYNC_INTERVAL_HOURS = "0";
    try { expect(await runObservedSuspension()).toBe(0); } finally { delete process.env.LLM_SYNC_INTERVAL_HOURS; }
  });
});
