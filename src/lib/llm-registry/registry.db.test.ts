import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { db, schema } from "@/db";
import { makeTenant } from "@/test/db";
import { startFakeLlmServer, type FakeLlmServer } from "../agents/fake-llm-server";
import { openBudget, runAgentTask } from "../agents/runner";
import { encryptSecret } from "../secret";
import { capFromSettings, getMonthlyCapEur, setMonthlyCapEur } from "./cap";
import { invalidatePriceBook, loadPriceBook } from "./pricebook";
import { rejectPendingPrice, validatePendingPrice } from "./price-validation";
import { claimSyncRun, runLlmSyncIfDue } from "./job";
import { refreshAvailabilityForKey, seedCatalog, syncLlmRegistry, syncPrices, type SyncDeps } from "./sync";

const NOW = new Date("2026-11-24T10:00:00Z");
const litellm = (over: Record<string, any> = {}) => ({
  "claude-haiku-5-5": { input_cost_per_token: 1e-7, output_cost_per_token: 5e-7, supports_response_schema: true, max_input_tokens: 1000000, max_output_tokens: 128000, input_cost_per_token_above_100k_tokens: 5e-7, output_cost_per_token_above_100k_tokens: 2.5e-6 },
  "claude-sonnet-5-5": { input_cost_per_token: 2e-6, output_cost_per_token: 1e-5, supports_response_schema: true },
  "gpt-6-luna": { input_cost_per_token: 1e-7, output_cost_per_token: 5e-7 },
  "gpt-6.1-terra": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  "mistral/mistral-small-2603": { input_cost_per_token: 1.5e-7, output_cost_per_token: 6e-7 },
  ...over,
});
/** fetch factice : sert le fichier de prix et les listes de modèles ; consigne les appels. */
function fakeFetch(handlers: { prices?: () => Response | Promise<Response>; anthropic?: () => Response; openai?: () => Response }) {
  const calls: string[] = [];
  const f = (async (url: string | URL) => {
    const u = String(url); calls.push(u);
    if (u.includes("model_prices")) return handlers.prices ? handlers.prices() : new Response("{}", { status: 404 });
    if (u.startsWith("https://api.anthropic.com/v1/models")) return handlers.anthropic ? handlers.anthropic() : new Response("{}", { status: 500 });
    if (u.startsWith("https://api.openai.com/v1/models")) return handlers.openai ? handlers.openai() : new Response("{}", { status: 500 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
const deps = (f: typeof fetch, extra: Partial<SyncDeps> = {}): SyncDeps => ({ fetchImpl: f, now: NOW, env: {}, keys: async () => ({}), ...extra });
const reset = async () => { await db.delete(schema.llmPriceSnapshots); await db.delete(schema.llmModels); await db.delete(schema.llmSyncRuns); invalidatePriceBook(); };

describe("registre LLM : prix (base réelle)", () => {
  beforeEach(reset);

  it("première synchronisation : le catalogue et les 5 prix sont enregistrés, validés", async () => {
    const { f } = fakeFetch({ prices: () => json(litellm()) });
    await seedCatalog();
    const s = await syncPrices(deps(f));
    expect(s.source).toBe("litellm");
    expect(s.recorded.sort()).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "gpt-6-luna", "gpt-6.1-terra", "mistral-small-2603"]);
    const book = await loadPriceBook();
    expect(book.size).toBe(5);
    expect(book.get("claude-haiku-5-5")!.price).toEqual({ inputPerMtok: 0.1, outputPerMtok: 0.5, long: { thresholdTokens: 100000, inputPerMtok: 0.5, outputPerMtok: 2.5 } });
    // tailles et JSON structuré du fichier reprises dans le registre
    const [h] = await db.select().from(schema.llmModels).where(eq(schema.llmModels.modelId, "claude-haiku-5-5"));
    expect(h).toMatchObject({ supportsJson: true, maxInputTokens: 1000000, maxOutputTokens: 128000, tier: "eco", provider: "anthropic", lifecycle: "UNKNOWN" });
  });

  it("rejouer la synchronisation à l'identique n'ajoute aucune ligne (idempotent)", async () => {
    const { f } = fakeFetch({ prices: () => json(litellm()) });
    await seedCatalog(); await syncPrices(deps(f));
    const before = (await db.select().from(schema.llmPriceSnapshots)).length;
    const s = await syncPrices(deps(f));
    expect(s.unchanged).toHaveLength(5);
    expect(s.recorded).toHaveLength(0);
    expect((await db.select().from(schema.llmPriceSnapshots)).length).toBe(before);
  });

  it("prix modifié dans le fichier : signalé « à vérifier », l'ancien prix reste en vigueur jusqu'à validation", async () => {
    await seedCatalog();
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    const changed = fakeFetch({ prices: () => json(litellm({ "gpt-6-luna": { input_cost_per_token: 3e-7, output_cost_per_token: 5e-7 } })) });
    const s = await syncPrices(deps(changed.f));
    expect(s.flagged).toEqual(["gpt-6-luna"]);
    expect((await loadPriceBook()).get("gpt-6-luna")!.price.inputPerMtok).toBe(0.1);
    const pending = await db.select().from(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.status, "PENDING"));
    expect(pending).toHaveLength(1);
    // une deuxième passe avec le même changement ne crée pas de doublon
    await syncPrices(deps(changed.f));
    expect(await db.select().from(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.status, "PENDING"))).toHaveLength(1);
    // validation en un clic : le nouveau prix s'applique
    expect(await validatePendingPrice("gpt-6-luna", "usr_1", new Date(NOW.getTime() + 1000))).toBe(true);
    expect((await loadPriceBook()).get("gpt-6-luna")!.price.inputPerMtok).toBe(0.3);
    expect(await validatePendingPrice("gpt-6-luna", "usr_1")).toBe(false);
  });

  it("changement refusé : le prix validé reste en vigueur, et rien n'est signalé quand le fichier revient à ce prix", async () => {
    await seedCatalog();
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    const changed = fakeFetch({ prices: () => json(litellm({ "gpt-6.1-terra": { input_cost_per_token: 2e-6, output_cost_per_token: 5e-6 } })) });
    await syncPrices(deps(changed.f));
    expect(await rejectPendingPrice("gpt-6.1-terra", "usr_1")).toBe(true);
    expect((await loadPriceBook()).get("gpt-6.1-terra")!.price.inputPerMtok).toBe(1);
    // le fichier revient à la valeur validée : rien à signaler
    const back = await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    expect(back.flagged).toHaveLength(0);
  });

  it("un changement en attente disparaît quand le fichier revient au prix validé", async () => {
    await seedCatalog();
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm({ "gpt-6-luna": { input_cost_per_token: 9e-7, output_cost_per_token: 5e-7 } })) }).f));
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    expect(await db.select().from(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.status, "PENDING"))).toHaveLength(0);
  });

  it("modèle absent du fichier : sans prix, donc pas dans le livre ; une surcharge d'environnement le renseigne", async () => {
    await seedCatalog();
    const file = litellm(); delete (file as any)["gpt-6-luna"];
    const s = await syncPrices(deps(fakeFetch({ prices: () => json(file) }).f));
    expect(s.missing).toEqual(["gpt-6-luna"]);
    expect((await loadPriceBook()).has("gpt-6-luna")).toBe(false);
    const s2 = await syncPrices(deps(fakeFetch({ prices: () => json(file) }).f, { env: { LLM_PRICE_OVERRIDES: '{"gpt-6-luna":{"input":0.1,"output":0.5}}' } }));
    expect(s2.overridden).toEqual(["gpt-6-luna"]);
    expect((await loadPriceBook()).get("gpt-6-luna")!.price).toMatchObject({ inputPerMtok: 0.1, outputPerMtok: 0.5 });
  });

  it("une surcharge posée par l'exploitant s'applique directement, sans validation, même si le prix change", async () => {
    await seedCatalog();
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    const s = await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f, { env: { LLM_PRICE_OVERRIDES: '{"claude-sonnet-5-5":{"input":3,"output":15}}' } }));
    expect(s.overridden).toEqual(["claude-sonnet-5-5"]);
    expect((await loadPriceBook()).get("claude-sonnet-5-5")!.price).toMatchObject({ inputPerMtok: 3, outputPerMtok: 15 });
  });

  it("deux instantanés de même horodatage : le dernier inséré est toujours le prix en vigueur (jamais tiré au hasard)", async () => {
    await seedCatalog();
    for (let i = 0; i < 5; i++) {
      await db.delete(schema.llmPriceSnapshots);
      for (const price of ["2", "3"]) await db.insert(schema.llmPriceSnapshots).values({ id: `llmp_${Math.random().toString(36).slice(2)}`, modelId: "claude-sonnet-5-5", inputUsdPerMtok: price, outputUsdPerMtok: "10", source: "OVERRIDE", status: "VALIDATED", observedAt: NOW, validatedAt: NOW, validatedBy: "system" });
      invalidatePriceBook();
      expect((await loadPriceBook()).get("claude-sonnet-5-5")!.price.inputPerMtok).toBe(3);
    }
  });

  it("deux passes qui signalent le même changement en même temps : aucune erreur, un seul changement en attente, les autres modèles traités", async () => {
    await seedCatalog();
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    const changed = fakeFetch({ prices: () => json(litellm({ "gpt-6-luna": { input_cost_per_token: 3e-7, output_cost_per_token: 5e-7 }, "gpt-6.1-terra": { input_cost_per_token: 2e-6, output_cost_per_token: 5e-6 } })) });
    const [a, b] = await Promise.all([syncPrices(deps(changed.f)), syncPrices(deps(changed.f))]);
    expect(a.errors ?? []).toEqual([]);
    expect(b.errors ?? []).toEqual([]);
    const pending = await db.select().from(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.status, "PENDING"));
    expect(pending.map((p) => p.modelId).sort()).toEqual(["gpt-6-luna", "gpt-6.1-terra"]);
  });

  it("surcharge invalide : signalée, aucun prix appliqué à tort", async () => {
    await seedCatalog();
    const s = await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f, { env: { LLM_PRICE_OVERRIDES: "{pas du json" } }));
    expect(s.overridesError).toMatch(/LLM_PRICE_OVERRIDES/);
    expect(s.overridden).toHaveLength(0);
  });

  it("fichier de prix injoignable ou illisible : l'état connu est conservé, erreur remontée, rien ne casse", async () => {
    await seedCatalog();
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    for (const h of [() => new Response("", { status: 503 }), () => new Response("<html>", { status: 200 }), () => { throw new Error("réseau"); }]) {
      const s = await syncPrices(deps(fakeFetch({ prices: h as any }).f));
      expect(s.source).toBe("indisponible");
      expect(s.error).toBeTruthy();
      expect((await loadPriceBook()).size).toBe(5);
    }
  });
});

describe("registre LLM : disponibilité (base réelle)", () => {
  beforeEach(reset);
  const list = (ids: [string, string][]) => json({ data: ids.map(([id, lifecycle]) => ({ type: "model", id, lifecycle, max_input_tokens: 1000000, max_tokens: 128000, retires_at: lifecycle === "deprecated" ? "2026-12-01T00:00:00Z" : null, capabilities: { structured_outputs: { supported: true } } })), has_more: false, last_id: null });

  it("synchronisation complète avec une clé de propriétaire : Haiku actif, Sonnet déprécié, journal écrit", async () => {
    const f = fakeFetch({ prices: () => json(litellm()), anthropic: () => list([["claude-haiku-5-5", "active"], ["claude-sonnet-5-5", "deprecated"]]) }).f;
    const stats = await syncLlmRegistry(deps(f, { keys: async () => ({ anthropic: ["sk-ant-test-0123456789012345"] }) }));
    expect(stats.availability.anthropic).toMatchObject({ ok: true, seen: ["claude-haiku-5-5", "claude-sonnet-5-5"] });
    const rows = new Map((await db.select().from(schema.llmModels)).map((r) => [r.modelId, r]));
    expect(rows.get("claude-haiku-5-5")).toMatchObject({ lifecycle: "ACTIVE", supportsJson: true });
    expect(rows.get("claude-sonnet-5-5")).toMatchObject({ lifecycle: "DEPRECATED", retiresAt: new Date("2026-12-01T00:00:00Z") });
    // OpenAI / Mistral : aucune clé de propriétaire encore, donc aucun état inventé
    expect(rows.get("gpt-6-luna")!.lifecycle).toBe("UNKNOWN");
    const [run] = await db.select().from(schema.llmSyncRuns);
    expect(run).toMatchObject({ ok: true });
    expect(run.finishedAt).not.toBeNull();
  });

  it("un modèle que le fournisseur ne liste plus passe en ABSENT ; une liste en erreur ne change rien", async () => {
    await seedCatalog();
    const keys = async () => ({ anthropic: ["sk-ant-test-0123456789012345"] });
    await syncLlmRegistry(deps(fakeFetch({ prices: () => json(litellm()), anthropic: () => list([["claude-haiku-5-5", "active"], ["claude-sonnet-5-5", "active"]]) }).f, { keys }));
    await syncLlmRegistry(deps(fakeFetch({ prices: () => json(litellm()), anthropic: () => list([["claude-sonnet-5-5", "active"]]) }).f, { keys }));
    const lc = async (id: string) => (await db.select().from(schema.llmModels).where(eq(schema.llmModels.modelId, id)))[0].lifecycle;
    expect(await lc("claude-haiku-5-5")).toBe("ABSENT");
    // panne du fournisseur : on ne conclut jamais qu'un modèle a disparu
    const s = await syncLlmRegistry(deps(fakeFetch({ prices: () => json(litellm()), anthropic: () => new Response("{}", { status: 500 }) }).f, { keys }));
    expect(s.availability.anthropic).toMatchObject({ ok: false });
    expect(await lc("claude-sonnet-5-5")).toBe("ACTIVE");
    expect(await lc("claude-haiku-5-5")).toBe("ABSENT");
    expect((await db.select().from(schema.llmSyncRuns).where(eq(schema.llmSyncRuns.ok, false))).length).toBe(1);
  });

  it("accès restreint d'une seule clé : le modèle n'est déclaré absent que si AUCUNE clé ne le voit", async () => {
    await seedCatalog();
    let n = 0;
    const f = fakeFetch({ prices: () => json(litellm()), anthropic: () => (n++ % 2 === 0 ? list([["claude-sonnet-5-5", "active"]]) : list([["claude-haiku-5-5", "active"], ["claude-sonnet-5-5", "active"]])) }).f;
    await syncLlmRegistry(deps(f, { keys: async () => ({ anthropic: ["sk-ant-restreinte-0123456789012", "sk-ant-complete-01234567890123"] }) }));
    expect((await db.select().from(schema.llmModels).where(eq(schema.llmModels.modelId, "claude-haiku-5-5")))[0].lifecycle).toBe("ACTIVE");
  });

  it("enregistrement d'une clé : un modèle non listé par cette seule clé n'est jamais passé en ABSENT", async () => {
    await seedCatalog();
    await refreshAvailabilityForKey("anthropic", "sk-ant-test-0123456789012345", deps(fakeFetch({ anthropic: () => list([["claude-haiku-5-5", "active"], ["claude-sonnet-5-5", "active"]]) }).f));
    await refreshAvailabilityForKey("anthropic", "sk-ant-restreinte-0123456789012", deps(fakeFetch({ anthropic: () => list([["claude-haiku-5-5", "active"]]) }).f));
    expect((await db.select().from(schema.llmModels).where(eq(schema.llmModels.modelId, "claude-sonnet-5-5")))[0].lifecycle).toBe("ACTIVE");
  });

  it("une clé refusée (401) n'empêche pas d'essayer la clé suivante", async () => {
    let n = 0;
    const f = fakeFetch({ prices: () => json(litellm()), anthropic: () => (n++ === 0 ? new Response("{}", { status: 401 }) : list([["claude-haiku-5-5", "active"]])) }).f;
    const s = await syncLlmRegistry(deps(f, { keys: async () => ({ anthropic: ["sk-ant-revoquee-0123456789012", "sk-ant-valide-0123456789012345"] }) }));
    expect(s.availability.anthropic).toMatchObject({ ok: true });
  });

  it("à l'enregistrement d'une clé : la disponibilité est relue, sans jamais lever d'erreur", async () => {
    await refreshAvailabilityForKey("anthropic", "sk-ant-test-0123456789012345", deps(fakeFetch({ anthropic: () => list([["claude-haiku-5-5", "active"]]) }).f));
    expect((await db.select().from(schema.llmModels).where(eq(schema.llmModels.modelId, "claude-haiku-5-5")))[0].lifecycle).toBe("ACTIVE");
    await expect(refreshAvailabilityForKey("anthropic", "sk-ant-test-0123456789012345", deps(fakeFetch({ anthropic: () => { throw new Error("réseau"); } }).f))).resolves.toBeUndefined();
  });

  it("les clés enregistrées par les propriétaires sont lues (déchiffrées) pour la disponibilité, jamais une clé du serveur", async () => {
    process.env.APP_SECRET ||= "test-app-secret-0123456789abcdef";
    const t = await makeTenant("registre");
    await db.insert(schema.llmCredentials).values({ tenantId: t.tenantId, provider: "anthropic", apiKeyEnc: encryptSecret("sk-ant-proprietaire-0123456789"), keyHint: "…6789" });
    const seen: string[] = [];
    const f = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("model_prices")) return json(litellm());
      seen.push(String((init?.headers as Record<string, string>)?.["x-api-key"]));
      return list([["claude-haiku-5-5", "active"]]);
    }) as unknown as typeof fetch;
    process.env.ANTHROPIC_API_KEY = "sk-ant-cle-serveur-ne-doit-pas-servir";
    try { await syncLlmRegistry({ fetchImpl: f, now: NOW, env: { ANTHROPIC_API_KEY: "sk-ant-cle-serveur-ne-doit-pas-servir" } }); }
    finally { delete process.env.ANTHROPIC_API_KEY; }
    expect(seen).toContain("sk-ant-proprietaire-0123456789");
    expect(seen).not.toContain("sk-ant-cle-serveur-ne-doit-pas-servir");
  });

  it("job : ne relance pas avant l'échéance, et jamais si LLM_SYNC_INTERVAL_HOURS=0", async () => {
    process.env.LLM_SYNC_INTERVAL_HOURS = "0";
    try { expect(await runLlmSyncIfDue(NOW)).toBe(false); } finally { delete process.env.LLM_SYNC_INTERVAL_HOURS; }
    expect((await db.select().from(schema.llmSyncRuns)).length).toBe(0);
    await db.insert(schema.llmSyncRuns).values({ id: "llms_recent", startedAt: new Date(NOW.getTime() - 3600_000), ok: true });
    expect(await runLlmSyncIfDue(NOW)).toBe(false);
  });

  it("job : deux instances en même temps ne lancent qu'une passe ; après un échec, nouvel essai au bout d'une heure", async () => {
    const [a, b] = await Promise.all([claimSyncRun(NOW, 24), claimSyncRun(NOW, 24)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    // la passe est en cours (non terminée) : bloquée 1 h, puis reprise
    expect(await claimSyncRun(new Date(NOW.getTime() + 30 * 60_000), 24)).toBeNull();
    expect(await claimSyncRun(new Date(NOW.getTime() + 61 * 60_000), 24)).not.toBeNull();
    // une passe réussie bloque jusqu'à l'intervalle
    await db.delete(schema.llmSyncRuns);
    await db.insert(schema.llmSyncRuns).values({ id: "llms_ok", startedAt: NOW, ok: true });
    expect(await claimSyncRun(new Date(NOW.getTime() + 5 * 3600_000), 24)).toBeNull();
    expect(await claimSyncRun(new Date(NOW.getTime() + 25 * 3600_000), 24)).not.toBeNull();
  });
});

describe("registre LLM : coût réel tracé dans agent_runs (base réelle, faux serveur de modèle)", () => {
  let srv: FakeLlmServer, t: Awaited<ReturnType<typeof makeTenant>>;
  const Out = z.object({ answer: z.string().min(3) });
  beforeAll(async () => { srv = await startFakeLlmServer(() => '{"answer":"bonjour"}'); t = await makeTenant("cout"); }, 60_000);
  afterAll(async () => { await srv.close(); });
  beforeEach(async () => { await reset(); process.env.ANTHROPIC_API_BASE = srv.url; process.env.ANTHROPIC_API_KEY = "sk-ant-serveur-de-test-0123456789"; process.env.ANTHROPIC_MODEL = "claude-haiku-5-5"; });
  const run = async () => { const o = await runAgentTask({ budget: await openBudget(t.tenantId), agentId: "direction", operation: "test", prompt: "direction.explain_action", user: "Faits : x", schema: Out, summary: ({ mode }) => `Essai ${mode}`, fallback: () => ({ answer: "repli" }) }); await db.insert(schema.agentRuns).values(o.run); return o; };
  const cleanup = () => { for (const k of ["ANTHROPIC_API_BASE", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) delete process.env[k]; };
  afterAll(cleanup);

  it("prix validé connu : le coût est calculé à partir des jetons déclarés et rattaché à l'instantané de prix", async () => {
    await seedCatalog();
    await syncPrices(deps(fakeFetch({ prices: () => json(litellm()) }).f));
    const o = await run();
    expect(o.mode).toBe("LLM");
    const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, o.run.id!));
    const expected = ((row.inputTokens ?? 0) * 0.1 + (row.outputTokens ?? 0) * 0.5) / 1e6;
    expect(Number(row.costUsd)).toBeCloseTo(expected, 6);
    expect(row.priceSnapshotId).toBe((await loadPriceBook()).get("claude-haiku-5-5")!.snapshotId);
    expect(row.costEstimatedUsd).toBeNull();
    expect((row.trace as any).tried[0]).toMatchObject({ model: "claude-haiku-5-5", outcome: "OK" });
    expect((row.trace as any).tried[0].inputTokens).toBe(row.inputTokens);
  });

  it("prix inconnu : coût null (jamais zéro ni inventé), l'appel fonctionne comme avant", async () => {
    const o = await run();
    expect(o.mode).toBe("LLM");
    const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, o.run.id!));
    expect(row.costUsd).toBeNull();
    expect(row.priceSnapshotId).toBeNull();
  });

  it("sans fournisseur : aucun appel, aucun coût", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const o = await run();
    expect(o.reason).toBe("NO_PROVIDER");
    const [row] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, o.run.id!));
    expect(row.costUsd).toBeNull();
  });
});

describe("plafond mensuel en euros (base réelle)", () => {
  it("vide par défaut, enregistré, remplacé, effacé, sans écraser les autres réglages", async () => {
    const t = await makeTenant("plafond");
    await db.update(schema.tenants).set({ settings: { scoring: { x: 1 }, agentModels: { direction: "claude-haiku-5-5" } } }).where(eq(schema.tenants.id, t.tenantId));
    expect(await getMonthlyCapEur(t.tenantId)).toBeNull();
    await setMonthlyCapEur(t.tenantId, 25);
    expect(await getMonthlyCapEur(t.tenantId)).toBe(25);
    await setMonthlyCapEur(t.tenantId, 12.5);
    expect(await getMonthlyCapEur(t.tenantId)).toBe(12.5);
    const [row] = await db.select({ s: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, t.tenantId));
    expect(row.s).toMatchObject({ scoring: { x: 1 }, agentModels: { direction: "claude-haiku-5-5" }, llmMonthlyCapEur: 12.5 });
    expect(capFromSettings(row.s)).toBe(12.5);
    await setMonthlyCapEur(t.tenantId, null);
    expect(await getMonthlyCapEur(t.tenantId)).toBeNull();
    const [after] = await db.select({ s: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, t.tenantId));
    expect(after.s).toEqual({ scoring: { x: 1 }, agentModels: { direction: "claude-haiku-5-5" } });
  });
});
