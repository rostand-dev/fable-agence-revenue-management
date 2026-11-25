import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, newId, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { setOwnerKey } from "@/test/llm-keys";
import { BENCH_HOURLY_LIMIT, BENCH_MODEL_COOLDOWN_MIN } from "./bench";
import { benchPreflight, BENCH_AGENT_ID } from "./bench-guard";
import { monthlySpendUsd, setMonthlyCapEur } from "./cap";
import { agentCosts, modelsOverview } from "./overview";
import { invalidatePriceBook } from "./pricebook";
import { rejectPendingPrice, validatePendingPrice } from "./price-validation";
import { seedCatalog, syncPrices } from "./sync";

const NOW = new Date();
const LITELLM = {
  "claude-haiku-5-5": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  "claude-sonnet-5-5": { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
  "gpt-6-luna": { input_cost_per_token: 2e-7, output_cost_per_token: 1.6e-6 },
  "gpt-6.1-terra": { input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5 },
  "mistral/mistral-small-2603": { input_cost_per_token: 1e-7, output_cost_per_token: 3e-7 },
};
const fetchWith = (doc: object) => (async (u: string | URL) => (String(u).includes("model_prices") ? new Response(JSON.stringify(doc)) : new Response("{}", { status: 404 }))) as unknown as typeof fetch;
async function setup(doc: object = LITELLM) {
  await db.delete(schema.llmQualifications); await db.delete(schema.llmPriceSnapshots); await db.delete(schema.llmModels); invalidatePriceBook();
  await seedCatalog();
  await syncPrices({ fetchImpl: fetchWith(doc), now: NOW, env: {}, keys: async () => ({}) });
  await db.update(schema.llmModels).set({ lifecycle: "ACTIVE" });
  invalidatePriceBook();
}
const run = (tenantId: string, over: Partial<typeof schema.agentRuns.$inferInsert> = {}) => db.insert(schema.agentRuns).values({ id: newId("run"), tenantId, agentId: "direction", operation: "synthese", mode: "LLM", summary: "x", ...over });

describe("écran Modèles : états des modèles (base réelle)", () => {
  beforeEach(() => setup());

  it("sans clé, aucun modèle n'est disponible ; avec la clé Anthropic, ses modèles le deviennent, pas ceux des autres fournisseurs", async () => {
    const t = await makeTenant("ov-cle");
    expect((await modelsOverview(t.tenantId)).every((r) => r.state === "indisponible" && !r.hasKey)).toBe(true);
    await setOwnerKey(t.tenantId);
    const by = Object.fromEntries((await modelsOverview(t.tenantId)).map((r) => [r.model.modelId, r.state]));
    expect(by["claude-haiku-5-5"]).toBe("disponible"); expect(by["claude-sonnet-5-5"]).toBe("disponible"); expect(by["gpt-6-luna"]).toBe("indisponible");
  });

  it("qualifié quand toutes ses tâches le sont ; une tâche suspendue le ramène à disponible ; déprécié prime", async () => {
    const t = await makeTenant("ov-qual"); await setOwnerKey(t.tenantId);
    const { tasksFor } = await import("./bench");
    const tasks = tasksFor("claude-haiku-5-5");
    await db.insert(schema.llmQualifications).values(tasks.map((task) => ({ modelId: "claude-haiku-5-5", task, status: "QUALIFIED", benchScore: "0.9800", benchCases: 8 })));
    const st = async (id = "claude-haiku-5-5") => (await modelsOverview(t.tenantId)).find((r) => r.model.modelId === id)!;
    expect((await st()).state).toBe("qualifie"); expect((await st()).tasksQualified).toBe(tasks.length);
    await db.update(schema.llmQualifications).set({ status: "SUSPENDED" }).where(eq(schema.llmQualifications.task, tasks[0]));
    expect((await st()).state).toBe("disponible");
    await db.update(schema.llmModels).set({ lifecycle: "DEPRECATED" }).where(eq(schema.llmModels.modelId, "claude-haiku-5-5"));
    expect((await st()).state).toBe("deprecie");
  });

  it("changement de prix détecté : « prix à vérifier » avec l'ancien et le nouveau prix ; la validation en un clic le remplace, le refus garde l'ancien", async () => {
    const t = await makeTenant("ov-prix"); await setOwnerKey(t.tenantId);
    const doc = { ...LITELLM, "claude-haiku-5-5": { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5 } };
    await syncPrices({ fetchImpl: fetchWith(doc), now: NOW, env: {}, keys: async () => ({}) });
    const row = async () => (await modelsOverview(t.tenantId)).find((r) => r.model.modelId === "claude-haiku-5-5")!;
    const r = await row();
    expect(r.state).toBe("prix_a_verifier"); expect(r.price?.inputPerMtok).toBe(1); expect(r.pending?.inputPerMtok).toBe(2);
    expect(await validatePendingPrice("claude-haiku-5-5", "usr_test")).toBe(true);
    const v = await row();
    expect(v.pending).toBeNull(); expect(v.price?.inputPerMtok).toBe(2); expect(v.state).toBe("disponible");
    expect(await validatePendingPrice("claude-haiku-5-5", "usr_test"), "déjà traité : rien à valider").toBe(false);
    // refus
    const doc2 = { ...LITELLM, "claude-haiku-5-5": { input_cost_per_token: 4e-6, output_cost_per_token: 2e-5 } };
    await syncPrices({ fetchImpl: fetchWith(doc2), now: NOW, env: {}, keys: async () => ({}) });
    expect((await row()).state).toBe("prix_a_verifier");
    expect(await rejectPendingPrice("claude-haiku-5-5", "usr_test")).toBe(true);
    expect((await row()).price?.inputPerMtok).toBe(2); expect((await row()).pending).toBeNull();
  });
});

describe("coût du mois par agent et tendance (base réelle)", () => {
  beforeEach(() => setup());
  const now = new Date(Date.UTC(2026, 10, 15, 12));

  it("somme par agent sur le mois, mois précédent à part, appels sans prix comptés à part, ligne « Tests de modèles » seulement si un test a eu lieu", async () => {
    const t = await makeTenant("ov-couts");
    await run(t.tenantId, { agentId: "direction", costUsd: "1.000000", createdAt: new Date(Date.UTC(2026, 10, 3)) });
    await run(t.tenantId, { agentId: "direction", costUsd: "2.000000", createdAt: new Date(Date.UTC(2026, 10, 10)) });
    await run(t.tenantId, { agentId: "direction", costUsd: null, createdAt: new Date(Date.UTC(2026, 10, 11)) });
    await run(t.tenantId, { agentId: "direction", costUsd: "31.000000", createdAt: new Date(Date.UTC(2026, 9, 20)) });
    await run(t.tenantId, { agentId: "direction", costUsd: "99.000000", createdAt: new Date(Date.UTC(2026, 8, 20)) }); // avant le mois précédent : ignoré
    const rows = await agentCosts(t.tenantId, now);
    expect(rows.find((r) => r.agentId === BENCH_AGENT_ID)).toBeUndefined();
    const d = rows.find((r) => r.agentId === "direction")!;
    expect(d.calls).toBe(3); expect(d.unpricedCalls).toBe(1);
    expect(d.currentEur).toBeCloseTo(3 * 0.92, 5); expect(d.previousEur).toBeCloseTo(31 * 0.92, 5);
    expect(d.trend).toBe("decroissante"); // 0,2 $/j contre 1 $/j
    await run(t.tenantId, { agentId: BENCH_AGENT_ID, operation: "bench", costUsd: "0.500000", createdAt: new Date(Date.UTC(2026, 10, 12)) });
    expect((await agentCosts(t.tenantId, now)).find((r) => r.agentId === BENCH_AGENT_ID)).toMatchObject({ title: "Tests de modèles", calls: 1 });
  });

  it("isolé par espace : le coût d'un autre propriétaire n'apparaît jamais", async () => {
    const a = await makeTenant("ov-iso-a"), b = await makeTenant("ov-iso-b");
    await run(b.tenantId, { costUsd: "5.000000", createdAt: new Date(Date.UTC(2026, 10, 5)) });
    expect((await agentCosts(a.tenantId, now)).every((r) => r.currentEur === 0 && r.trend === "aucun")).toBe(true);
  });
});

describe("test d'un modèle : contrôles préalables (base réelle)", () => {
  beforeEach(() => setup());

  it("refuse sans clé, hors liste de la clé, et modèle inconnu", async () => {
    const t = await makeTenant("bg-cle");
    expect((await benchPreflight(t.tenantId, "claude-haiku-5-5"))).toMatchObject({ ok: false, error: expect.stringContaining("clé API Anthropic") });
    expect((await benchPreflight(t.tenantId, "modele-inconnu"))).toMatchObject({ ok: false, error: "Modèle inconnu." });
    await setOwnerKey(t.tenantId, undefined, "anthropic", ["claude-sonnet-5-5"]);
    expect((await benchPreflight(t.tenantId, "claude-haiku-5-5"))).toMatchObject({ ok: false, error: expect.stringContaining("ne figure pas dans la liste") });
  });

  it("accepte et chiffre le coût estimé ; refuse si le prix est inconnu (jamais inventé)", async () => {
    const t = await makeTenant("bg-prix"); await setOwnerKey(t.tenantId);
    const ok = await benchPreflight(t.tenantId, "claude-haiku-5-5");
    expect(ok.ok).toBe(true); if (ok.ok) expect(ok.estimateUsd).toBeGreaterThan(0);
    await db.delete(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.modelId, "claude-haiku-5-5")); invalidatePriceBook();
    expect(await benchPreflight(t.tenantId, "claude-haiku-5-5")).toMatchObject({ ok: false, error: expect.stringContaining("prix de ce modèle n'est pas connu") });
  });

  it("plafond : refusé s'il est atteint, refusé si le test le ferait dépasser, accepté sinon", async () => {
    const t = await makeTenant("bg-cap"); await setOwnerKey(t.tenantId);
    const est = await benchPreflight(t.tenantId, "claude-haiku-5-5"); if (!est.ok) throw new Error("estimation attendue");
    await setMonthlyCapEur(t.tenantId, 100);
    expect((await benchPreflight(t.tenantId, "claude-haiku-5-5")).ok).toBe(true);
    // il ne reste presque rien : le test dépasserait
    await run(t.tenantId, { costUsd: String(100 / 0.92 - est.estimateUsd / 2) });
    expect(await benchPreflight(t.tenantId, "claude-haiku-5-5")).toMatchObject({ ok: false, error: expect.stringContaining("dépasserait le plafond") });
    // atteint
    await run(t.tenantId, { costUsd: "10" });
    expect(await monthlySpendUsd(t.tenantId)).toBeGreaterThan(100 / 0.92);
    expect(await benchPreflight(t.tenantId, "claude-haiku-5-5")).toMatchObject({ ok: false, error: expect.stringContaining("plafond mensuel de dépense est atteint") });
    await setMonthlyCapEur(t.tenantId, null);
    expect((await benchPreflight(t.tenantId, "claude-haiku-5-5")).ok, "sans plafond").toBe(true);
  });

  it(`cadence : un test par modèle toutes les ${BENCH_MODEL_COOLDOWN_MIN} min, ${BENCH_HOURLY_LIMIT} par heure ; propre à l'espace`, async () => {
    const t = await makeTenant("bg-cadence"), autre = await makeTenant("bg-cadence-autre"); await setOwnerKey(t.tenantId); await setOwnerKey(autre.tenantId);
    const now = new Date();
    await run(t.tenantId, { agentId: BENCH_AGENT_ID, operation: "bench", model: "claude-haiku-5-5", createdAt: new Date(now.getTime() - 5 * 60_000) });
    expect(await benchPreflight(t.tenantId, "claude-haiku-5-5", now)).toMatchObject({ ok: false, error: expect.stringContaining("déjà été testé") });
    expect((await benchPreflight(t.tenantId, "claude-sonnet-5-5", now)).ok, "un autre modèle reste testable").toBe(true);
    expect((await benchPreflight(autre.tenantId, "claude-haiku-5-5", now)).ok, "l'autre espace n'est pas concerné").toBe(true);
    expect((await benchPreflight(t.tenantId, "claude-haiku-5-5", new Date(now.getTime() + 11 * 60_000))).ok, "15 min plus tard").toBe(true);
    for (let i = 0; i < BENCH_HOURLY_LIMIT - 1; i++) await run(t.tenantId, { agentId: BENCH_AGENT_ID, operation: "bench", model: "gpt-6-luna", createdAt: new Date(now.getTime() - (20 + i) * 60_000) });
    expect(await benchPreflight(t.tenantId, "claude-sonnet-5-5", now)).toMatchObject({ ok: false, error: expect.stringContaining("tests par heure") });
  });
});
