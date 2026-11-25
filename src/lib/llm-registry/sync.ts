/**
 * Synchronisation du registre LLM (job quotidien et à l'enregistrement d'une clé) : catalogue, prix, disponibilité.
 * Entrées-sorties uniquement ; les décisions viennent des fonctions pures (prices.ts, availability.ts).
 * Aucune donnée de propriétaire n'est envoyée : seules les listes de modèles sont lues, avec une clé de propriétaire pour la disponibilité.
 * Une panne ne détruit jamais l'état connu : un fichier de prix injoignable ou une liste en erreur ne change rien.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { decryptSecret } from "../secret";
import { CATALOG, type ProviderKey } from "./catalog";
import { applyListing, PARSERS } from "./availability";
import { mistralBase, pricesUrl } from "./config";
import { decidePrice, parseLitellmPrices, parsePriceOverrides, samePrice, type PriceEntry } from "./prices";
import { invalidatePriceBook, latestValidated, snapshotToPrice } from "./pricebook";

type Env = Record<string, string | undefined>;
export type SyncDeps = {
  fetchImpl?: typeof fetch;
  now?: Date;
  env?: Env;
  /** Clés de propriétaires utilisables pour lire la disponibilité, par fournisseur (défaut : clés enregistrées). */
  keys?: () => Promise<Partial<Record<ProviderKey, string[]>>>;
};
export type SyncStats = {
  prices: { source: "litellm" | "indisponible"; error?: string; recorded: string[]; flagged: string[]; unchanged: string[]; missing: string[]; overridden: string[]; overridesError?: string; /** modèles dont le traitement a échoué (les autres sont traités) */ errors?: string[] };
  availability: Partial<Record<ProviderKey, { ok: boolean; error?: string; seen: string[]; absent: string[] }>>;
};

const MAX_PRICE_FILE_BYTES = 20 * 1024 * 1024;

async function getJson(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number, maxBytes = 5 * 1024 * 1024): Promise<unknown> {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // aucune redirection suivie : une clé API ne doit jamais partir vers une autre adresse
    const res = await f(url, { ...init, signal: ctrl.signal, cache: "no-store", redirect: "error" });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    if (Number(res.headers.get("content-length") ?? 0) > maxBytes) throw new Error("réponse trop volumineuse");
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error("réponse trop volumineuse");
    return JSON.parse(new TextDecoder().decode(buf));
  } finally { clearTimeout(timer); }
}

/** Les modèles du catalogue existent toujours dans le registre ; la disponibilité n'est jamais écrasée ici. */
export async function seedCatalog(): Promise<void> {
  for (const m of CATALOG) {
    await db.insert(schema.llmModels).values({ modelId: m.modelId, provider: m.provider, label: m.label, tier: m.tier, priceKey: m.priceKey })
      .onConflictDoUpdate({ target: schema.llmModels.modelId, set: { provider: m.provider, label: m.label, tier: m.tier, priceKey: m.priceKey } });
  }
}

async function validatedPrices(): Promise<Map<string, PriceEntry>> {
  const out = new Map<string, PriceEntry>();
  for (const [id, r] of await latestValidated()) out.set(id, snapshotToPrice(r));
  return out;
}

const priceCols = (p: PriceEntry) => ({
  inputUsdPerMtok: String(p.inputPerMtok), outputUsdPerMtok: String(p.outputPerMtok),
  longThresholdTokens: p.long?.thresholdTokens ?? null, longInputUsdPerMtok: p.long ? String(p.long.inputPerMtok) : null, longOutputUsdPerMtok: p.long ? String(p.long.outputPerMtok) : null,
});

export async function syncPrices(deps: SyncDeps = {}): Promise<SyncStats["prices"]> {
  const f = deps.fetchImpl ?? fetch, now = deps.now ?? new Date(), env = deps.env ?? process.env;
  const stats: SyncStats["prices"] = { source: "indisponible", recorded: [], flagged: [], unchanged: [], missing: [], overridden: [] };
  let facts = new Map<string, ReturnType<typeof parseLitellmPrices> extends Map<string, infer V> ? V : never>();
  try {
    facts = parseLitellmPrices(await getJson(f, pricesUrl(env), { headers: { accept: "application/json" } }, 30_000, MAX_PRICE_FILE_BYTES));
    stats.source = "litellm";
  } catch (e: any) { stats.error = e?.name === "AbortError" ? "Fichier de prix : délai dépassé." : `Fichier de prix illisible ou injoignable (${String(e?.message ?? "erreur").slice(0, 80)}).`; }
  const { overrides, error } = parsePriceOverrides(env.LLM_PRICE_OVERRIDES);
  if (error) stats.overridesError = error;
  const current = await validatedPrices();

  for (const m of CATALOG) {
   try {
    const override = overrides.get(m.modelId), fromFile = facts.get(m.modelId)?.price;
    const observed = override ?? fromFile;
    if (!observed) { stats.missing.push(m.modelId); continue; }
    const source = override ? "OVERRIDE" : "LITELLM";
    const decision = decidePrice(current.get(m.modelId) ?? null, observed);
    if (decision === "KEEP") {
      stats.unchanged.push(m.modelId);
      // le prix est revenu à la valeur validée : un changement en attente n'a plus d'objet
      await db.update(schema.llmPriceSnapshots).set({ status: "REJECTED", validatedAt: now, validatedBy: "system" }).where(and(eq(schema.llmPriceSnapshots.modelId, m.modelId), eq(schema.llmPriceSnapshots.status, "PENDING")));
      continue;
    }
    if (decision === "RECORD" || source === "OVERRIDE") {
      // première observation, ou surcharge posée par l'exploitant : appliquée directement
      await db.update(schema.llmPriceSnapshots).set({ status: "REJECTED", validatedAt: now, validatedBy: "system" }).where(and(eq(schema.llmPriceSnapshots.modelId, m.modelId), eq(schema.llmPriceSnapshots.status, "PENDING")));
      await db.insert(schema.llmPriceSnapshots).values({ id: newId("llmp"), modelId: m.modelId, ...priceCols(observed), source, status: "VALIDATED", observedAt: now, validatedAt: now, validatedBy: "system" });
      (source === "OVERRIDE" ? stats.overridden : stats.recorded).push(m.modelId);
      continue;
    }
    // prix modifié dans le fichier communautaire : signalé, appliqué seulement après validation
    const [pending] = await db.select().from(schema.llmPriceSnapshots).where(and(eq(schema.llmPriceSnapshots.modelId, m.modelId), eq(schema.llmPriceSnapshots.status, "PENDING")));
    if (pending && decidePrice(snapshotToPrice(pending), observed) === "KEEP") { stats.flagged.push(m.modelId); continue; }
    // un refus de l'exploitant tient : le même prix n'est pas signalé de nouveau à chaque synchronisation (les relevés remplacés par le système ne comptent pas)
    const [lastRefused] = await db.select().from(schema.llmPriceSnapshots).where(and(eq(schema.llmPriceSnapshots.modelId, m.modelId), eq(schema.llmPriceSnapshots.status, "REJECTED"), ne(schema.llmPriceSnapshots.validatedBy, "system"))).orderBy(desc(schema.llmPriceSnapshots.seq)).limit(1);
    if (!pending && lastRefused && samePrice(snapshotToPrice(lastRefused), observed)) continue;
    if (pending) await db.update(schema.llmPriceSnapshots).set({ status: "REJECTED", validatedAt: now, validatedBy: "system" }).where(eq(schema.llmPriceSnapshots.id, pending.id));
    // une passe concurrente a pu poser le même changement : l'index unique le refuse, sans erreur
    await db.insert(schema.llmPriceSnapshots).values({ id: newId("llmp"), modelId: m.modelId, ...priceCols(observed), source, status: "PENDING", observedAt: now }).onConflictDoNothing();
    stats.flagged.push(m.modelId);
   } catch (e: any) { (stats.errors ??= []).push(`${m.modelId} : ${String(e?.message ?? e).slice(0, 80)}`); }
  }

  // tailles et JSON structuré du fichier de prix : seulement là où la liste officielle ne les a pas renseignés
  for (const [modelId, fa] of facts) {
    const [row] = await db.select().from(schema.llmModels).where(eq(schema.llmModels.modelId, modelId));
    if (!row) continue;
    const set: Partial<typeof schema.llmModels.$inferInsert> = {};
    if (row.supportsJson === null && fa.supportsJson !== null) set.supportsJson = fa.supportsJson;
    if (row.maxInputTokens === null && fa.maxInputTokens !== null) set.maxInputTokens = Math.floor(fa.maxInputTokens);
    if (row.maxOutputTokens === null && fa.maxOutputTokens !== null) set.maxOutputTokens = Math.floor(fa.maxOutputTokens);
    if (Object.keys(set).length) await db.update(schema.llmModels).set({ ...set, updatedAt: now }).where(eq(schema.llmModels.modelId, modelId));
  }
  invalidatePriceBook();
  return stats;
}

const providerBase = (p: ProviderKey, env: Env): string =>
  p === "anthropic" ? (env.ANTHROPIC_API_BASE || "https://api.anthropic.com").replace(/\/$/, "")
  : p === "openai" ? (env.OPENAI_API_BASE || "https://api.openai.com").replace(/\/$/, "") : mistralBase(env);

/** Liste officielle COMPLÈTE des modèles d'un fournisseur avec une clé. Lève une erreur si la lecture est incomplète : jamais de liste partielle. */
export async function fetchProviderModels(provider: ProviderKey, apiKey: string, deps: SyncDeps = {}) {
  const f = deps.fetchImpl ?? fetch, base = providerBase(provider, deps.env ?? process.env);
  const headers: Record<string, string> = provider === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", accept: "application/json" } : { authorization: "Bearer " + apiKey, accept: "application/json" };
  if (provider !== "anthropic") return PARSERS[provider](await getJson(f, base + "/v1/models", { headers }, 15_000));
  const all: ReturnType<typeof PARSERS.anthropic> = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const data: any = await getJson(f, `${base}/v1/models?limit=100&lifecycle=active&lifecycle=deprecated&lifecycle=retired${after ? "&after_id=" + encodeURIComponent(after) : ""}`, { headers }, 15_000);
    all.push(...PARSERS.anthropic(data));
    if (!data?.has_more) return all;
    if (typeof data?.last_id !== "string") throw new Error("pagination incomplète");
    after = data.last_id;
  }
  throw new Error("trop de pages");
}

/** Écrit l'état de disponibilité des modèles d'un fournisseur d'après une liste complète. */
export async function recordAvailability(provider: ProviderKey, listed: Awaited<ReturnType<typeof fetchProviderModels>>, now: Date = new Date(), opts: { markAbsent?: boolean } = {}): Promise<{ seen: string[]; absent: string[] }> {
  const seen: string[] = [], absent: string[] = [];
  for (const u of applyListing(provider, listed)) {
    (u.seen ? seen : absent).push(u.modelId);
    // une seule clé (accès restreint) ne suffit pas à déclarer un modèle absent pour tout le monde : voir syncAvailability
    if (!u.seen && opts.markAbsent === false) continue;
    await db.update(schema.llmModels).set({
      lifecycle: u.lifecycle, deprecatedAt: u.deprecatedAt, retiresAt: u.retiresAt, updatedAt: now,
      ...(u.seen ? { lastSeenAt: now, maxInputTokens: u.maxInputTokens ?? undefined, maxOutputTokens: u.maxOutputTokens ?? undefined, supportsJson: u.supportsJson ?? undefined } : {}),
    }).where(eq(schema.llmModels.modelId, u.modelId));
  }
  return { seen, absent };
}

/** Clés de propriétaires enregistrées, par fournisseur (au plus 3 par fournisseur : une clé révoquée ne bloque pas la lecture). */
export async function storedKeys(): Promise<Partial<Record<ProviderKey, string[]>>> {
  const rows = await db.select({ provider: schema.llmCredentials.provider, enc: schema.llmCredentials.apiKeyEnc }).from(schema.llmCredentials).where(inArray(schema.llmCredentials.provider, ["anthropic", "openai", "mistral"])).orderBy(desc(schema.llmCredentials.updatedAt)).limit(30);
  const out: Partial<Record<ProviderKey, string[]>> = {};
  for (const r of rows) {
    const p = r.provider as ProviderKey;
    if ((out[p]?.length ?? 0) >= 3) continue;
    try { (out[p] ??= []).push(decryptSecret(r.enc)); } catch { /* clé illisible : ignorée */ }
  }
  return out;
}

/**
 * Lit la liste de chaque fournisseur avec TOUTES les clés enregistrées (3 au plus) : un modèle n'est déclaré ABSENT que si aucune clé ne le voit,
 * pour qu'un compte à l'offre restreinte ne l'exclue pas pour les autres. L'accès propre à chaque propriétaire se vérifie avec sa liste personnelle (PR 2).
 */
export async function syncAvailability(deps: SyncDeps = {}): Promise<SyncStats["availability"]> {
  const now = deps.now ?? new Date(), keys = await (deps.keys ?? storedKeys)();
  const out: SyncStats["availability"] = {};
  for (const provider of ["anthropic", "openai", "mistral"] as ProviderKey[]) {
    const list = keys[provider] ?? [];
    if (list.length === 0) continue;
    const lists: Awaited<ReturnType<typeof fetchProviderModels>>[] = [];
    let lastError = "";
    for (const key of list) {
      try { lists.push(await fetchProviderModels(provider, key, deps)); }
      catch (e: any) {
        // 401 / 403 : clé refusée ; toute autre erreur laisse l'état connu intact
        lastError = e?.status === 401 || e?.status === 403 ? "clé refusée par le fournisseur" : `lecture impossible (${String(e?.message ?? "erreur").slice(0, 60)})`;
      }
    }
    if (lists.length === 0) { out[provider] = { ok: false, error: lastError, seen: [], absent: [] }; continue; }
    // une clé ne lit pas forcément tout : on fusionne (le modèle le plus favorable l'emporte : ACTIVE avant DEPRECATED avant RETIRED)
    const rank = { ACTIVE: 0, DEPRECATED: 1, RETIRED: 2 } as const;
    const merged = new Map<string, (typeof lists)[number][number]>();
    for (const l of lists) for (const m of l) { const cur = merged.get(m.modelId); if (!cur || rank[m.lifecycle] < rank[cur.lifecycle]) merged.set(m.modelId, m); }
    out[provider] = { ok: true, ...(await recordAvailability(provider, [...merged.values()], now)) };
  }
  return out;
}

/** À l'enregistrement d'une clé : relit la disponibilité du fournisseur concerné avec cette clé. Ne lève jamais d'erreur. */
export async function refreshAvailabilityForKey(provider: ProviderKey, apiKey: string, deps: SyncDeps = {}): Promise<void> {
  try {
    await seedCatalog();
    await recordAvailability(provider, await fetchProviderModels(provider, apiKey, deps), deps.now ?? new Date(), { markAbsent: false });
  } catch (e) { console.error("[registre LLM] lecture de la disponibilité impossible", (e as any)?.message ?? e); }
}

/** Synchronisation complète : catalogue, prix, disponibilité. Journalisée dans llm_sync_runs ; une étape en échec n'empêche pas les autres. */
export async function syncLlmRegistry(deps: SyncDeps = {}, claimedRunId?: string): Promise<SyncStats> {
  const runId = claimedRunId ?? newId("llms"), now = deps.now ?? new Date();
  if (!claimedRunId) await db.insert(schema.llmSyncRuns).values({ id: runId, startedAt: now });
  await seedCatalog();
  const stats: SyncStats = { prices: { source: "indisponible", recorded: [], flagged: [], unchanged: [], missing: [], overridden: [] }, availability: {} };
  try { stats.prices = await syncPrices(deps); } catch (e: any) { stats.prices.error = "Étape des prix en erreur : " + String(e?.message ?? e).slice(0, 100); }
  try { stats.availability = await syncAvailability(deps); } catch (e: any) { stats.availability = { anthropic: { ok: false, error: "Étape de disponibilité en erreur : " + String(e?.message ?? e).slice(0, 100), seen: [], absent: [] } }; }
  const ok = !stats.prices.error && Object.values(stats.availability).every((a) => a?.ok);
  await db.update(schema.llmSyncRuns).set({ finishedAt: new Date(), ok, stats }).where(eq(schema.llmSyncRuns.id, runId));
  return stats;
}
