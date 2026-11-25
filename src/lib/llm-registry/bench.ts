/**
 * Banc d'évaluation des modèles (plan « routeur LLM », section 4) et suspension sur échecs observés.
 *
 * - Le banc ne s'exécute QUE sur demande (bouton « Tester ce modèle »), jamais dans la CI ni au démarrage : il appelle un vrai modèle avec la clé de la personne qui clique.
 * - Les cas sont SYNTHÉTIQUES (logements de démonstration passés dans le moteur) : aucune donnée de logement d'un propriétaire n'est envoyée.
 * - Réussite d'un cas = sortie JSON conforme au schéma ET aux garde-fous de l'agent (pièces connues, aucun chiffre inventé, aucune action proposée), comme en production.
 * - Statut : « non évalué » (pas de ligne) → « qualifié » (au moins 95 % de cas réussis) → « suspendu » (banc insuffisant, ou échecs observés en production sur 30 jours).
 * - Le résultat est partagé par tous les comptes : le comportement d'un modèle sur une tâche ne dépend pas de la clé qui l'appelle.
 */
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, schema } from "@/db";
import { addDays } from "../dates";
import { capabilityFlags } from "../integrations/capabilities";
import { buildDemo } from "../engine/demo";
import { reviewProperty, type EngineInput } from "../engine/detect";
import type { DetectedOpportunity } from "../engine/types";
import { generateJson, providerByKey } from "../agents/gateway";
import { PROMPTS, type PromptId } from "../agents/prompts";
import { analysisContext, analysisPrompt, analysisSchema } from "../agents/market-analysis";
import { opinionContext, opinionPrompt, opinionSchema, ownedOptions, type StrategistId } from "../agents/strategist-opinions";
import { reviewable, reviewContext, reviewPrompt, reviewSchema } from "../agents/independent-review";
import { narrativeFacts, OutSchema } from "../services/narrative";
import { catalogById, TIER_RANK } from "./catalog";
import { computeCostUsd } from "./prices";
import { getPriceBook } from "./pricebook";
import { PROFILES } from "./profiles";

/** Au plus un test par modèle toutes les 15 minutes, et 6 par heure pour l'espace : un test appelle de vrais modèles avec la clé du propriétaire, donc il coûte. */
export const BENCH_MODEL_COOLDOWN_MIN = 15;
export const BENCH_HOURLY_LIMIT = 6;

/** Seuil de réussite pour être (ou rester) qualifié. */
export const QUALIFY_THRESHOLD = 0.95;
/** Cas maximum par tâche (coût borné et prévisible). */
export const MAX_CASES_PER_TASK = 8;
/** Contrôle des échecs observés : fenêtre et nombre minimal d'appels avant de suspendre. */
export const OBSERVED_WINDOW_DAYS = 30;
export const OBSERVED_MIN_CALLS = 20;

export const BENCH_TASKS: readonly PromptId[] = ["direction.explain_action", "marche.market_analysis", "pricing.option_opinion", "distribution.option_opinion", "audit.independent_review"];

const TODAY = "2026-11-12";
function inputFor(key: string): EngineInput {
  const p = buildDemo(TODAY).find((x) => x.key === key)!;
  const now = new Date(TODAY + "T07:00:00Z");
  return {
    today: TODAY, now, property: { id: key, name: p.name, isDemo: true }, model: p.economics, strategy: p.strategy,
    days: p.days, resas: p.reservations.map((r) => ({ ...r, status: "CONFIRMED" })),
    promos: p.promos.map((x, i) => ({
      id: "p" + i, channel: x.channel, kind: x.kind, label: x.label, discountPct: x.discountPct,
      stayFrom: x.fromOffset === null ? null : addDays(TODAY, x.fromOffset), stayTo: x.toOffset === null ? null : addDays(TODAY, x.toOffset),
      verifiedAt: new Date(+now - x.verifiedDaysAgo * 86400000),
    })),
    capabilities: capabilityFlags({ isDemo: true, killSwitch: {} }), activeRanges: [],
  };
}

export type BenchCase = { user: string; schema: z.ZodType<unknown> };

/** Cas synthétiques d'une tâche : dossiers des deux logements de démonstration, dans un ordre fixe. */
export function benchCases(task: PromptId, max = MAX_CASES_PER_TASK): BenchCase[] {
  const out: BenchCase[] = [];
  const opps: { o: DetectedOpportunity; name: string }[] = [];
  for (const key of ["chatillon", "evry"]) for (const o of reviewProperty(inputFor(key)).opportunities) opps.push({ o, name: buildDemo(TODAY).find((x) => x.key === key)!.name });
  for (const { o, name } of opps) {
    if (task === "direction.explain_action") out.push({ user: "Faits certifiés du dossier :\n" + JSON.stringify(narrativeFacts(o, name), null, 1), schema: OutSchema });
    else if (task === "marche.market_analysis") out.push({ user: analysisPrompt(o), schema: analysisSchema(analysisContext(o)) });
    else if (task === "audit.independent_review") { if (reviewable(o)) out.push({ user: reviewPrompt(o), schema: reviewSchema(reviewContext(o)) }); }
    else { const agent = task.split(".")[0] as StrategistId; if (ownedOptions(o, agent).length > 0) out.push({ user: opinionPrompt(o, agent), schema: opinionSchema(opinionContext(o, agent)) }); }
  }
  return out.slice(0, max);
}

/** Tâches sur lesquelles un modèle est évalué : celles dont le profil accepte son niveau (un modèle économique n'est pas testé pour l'audit premium). */
export function tasksFor(modelId: string): PromptId[] {
  const tier = catalogById(modelId)?.tier;
  if (!tier) return [];
  return BENCH_TASKS.filter((t) => { const p = PROFILES[t]; return TIER_RANK[tier] >= TIER_RANK[p.minTier] && TIER_RANK[tier] <= TIER_RANK[p.maxTier] && (!p.neverDowngrade || tier === p.minTier); });
}

/** Coût estimé du banc d'un modèle (USD), montré avant le clic ; null si le prix du modèle est inconnu (jamais inventé). */
export async function estimateBenchCostUsd(modelId: string): Promise<{ costUsd: number | null; calls: number }> {
  const book = await getPriceBook(), price = book.get(modelId)?.price;
  let total = 0, calls = 0;
  for (const t of tasksFor(modelId)) {
    const n = benchCases(t).length, p = PROFILES[t];
    calls += n;
    const one = computeCostUsd(price, p.estInputTokens, p.estOutputTokens);
    if (one === null) return { costUsd: null, calls: 0 };
    total += n * one;
  }
  return { costUsd: total, calls };
}

/** Statut d'un banc : pur et testable. */
export function benchVerdict(ok: number, total: number): { status: "QUALIFIED" | "SUSPENDED"; score: number; reason: string | null } {
  const score = total === 0 ? 0 : ok / total;
  return score >= QUALIFY_THRESHOLD && total > 0 ? { status: "QUALIFIED", score, reason: null } : { status: "SUSPENDED", score, reason: total === 0 ? "aucun cas évalué" : `banc insuffisant : ${ok} cas réussis sur ${total} (seuil ${Math.round(QUALIFY_THRESHOLD * 100)} %)` };
}

export type BenchOutcome =
  | { ok: true; results: { task: PromptId; ok: number; total: number; status: "QUALIFIED" | "SUSPENDED"; score: number }[]; costUsd: number | null }
  | { ok: false; error: string; /** coût déjà engagé avant l'interruption (null = prix inconnu) */ costUsd?: number | null };

/**
 * Lance le banc d'un modèle avec LA clé de la personne qui clique, sur des cas synthétiques. Une panne du fournisseur (clé refusée, réseau, quota) ne compte pas comme un échec du modèle :
 * le banc est alors interrompu sans rien écrire. `respond` n'existe que pour les tests (fournisseur injecté).
 */
export async function runBench(input: { modelId: string; apiKey: string; evaluatedBy: string; provider?: ReturnType<typeof providerByKey> }): Promise<BenchOutcome> {
  const m = catalogById(input.modelId);
  if (!m) return { ok: false, error: "Ce modèle n'est pas dans le catalogue du routeur." };
  const provider = input.provider ?? providerByKey(m.provider);
  const tasks = tasksFor(m.modelId);
  if (tasks.length === 0) return { ok: false, error: "Aucune tâche à évaluer pour ce modèle." };
  const results: Extract<BenchOutcome, { ok: true }>["results"] = [], rows: (typeof schema.llmQualifications.$inferInsert)[] = [];
  let costUsd: number | null = 0;
  const book = await getPriceBook();
  for (const task of tasks) {
    const cases = benchCases(task);
    let ok = 0;
    for (const c of cases) {
      const r = await generateJson([{ provider, apiKey: input.apiKey, model: m.modelId, source: "utilisateur" }], { task, system: PROMPTS[task].system, user: c.user, schema: c.schema, maxTokens: PROMPTS[task].maxTokens, maxAttempts: 2 });
      const providerFailure = r.meta.tried.some((t) => t.outcome === "PROVIDER_ERROR");
      if (providerFailure && !r.ok) { const c0 = computeCostUsd(book.get(m.modelId)?.price, r.meta.inputTokens, r.meta.outputTokens); return { ok: false, error: `Banc interrompu : ${r.message.replace(/ Repli déterministe\.$/, "")} Aucun résultat enregistré.`, costUsd: costUsd === null || c0 === null ? null : costUsd + c0 }; }
      if (r.ok) ok++;
      const c1 = computeCostUsd(book.get(m.modelId)?.price, r.meta.inputTokens, r.meta.outputTokens);
      costUsd = costUsd === null || c1 === null ? null : costUsd + c1;
    }
    const v = benchVerdict(ok, cases.length);
    results.push({ task, ok, total: cases.length, status: v.status, score: v.score });
    rows.push({ modelId: m.modelId, task, status: v.status, benchScore: v.score.toFixed(4), benchCases: cases.length, reason: v.reason, details: { ok, total: cases.length, threshold: QUALIFY_THRESHOLD }, evaluatedAt: new Date(), evaluatedBy: input.evaluatedBy });
  }
  // tout est écrit d'un bloc : jamais un résultat à moitié enregistré
  await db.transaction(async (tx) => {
    for (const r of rows) await tx.insert(schema.llmQualifications).values(r).onConflictDoUpdate({ target: [schema.llmQualifications.modelId, schema.llmQualifications.task], set: { status: r.status, benchScore: r.benchScore, benchCases: r.benchCases, reason: r.reason, details: r.details, evaluatedAt: r.evaluatedAt, evaluatedBy: r.evaluatedBy } });
  });
  return { ok: true, results, costUsd };
}

/** Faut-il suspendre ? Pur : réussite observée (réponses valides sur réponses valides + invalides) sous le seuil, avec assez d'appels. Les pannes du fournisseur ne comptent pas. */
export function observedVerdict(ok: number, failed: number): { suspend: boolean; rate: number | null } {
  const n = ok + failed;
  if (n < OBSERVED_MIN_CALLS) return { suspend: false, rate: n === 0 ? null : ok / n };
  const rate = ok / n;
  return { suspend: rate < QUALIFY_THRESHOLD, rate };
}

/**
 * Suspension automatique d'après la production : pour chaque modèle qualifié et chaque tâche, taux de réussite sur 30 jours (traces des essais de la passerelle).
 * Un modèle sous 95 % passe en « suspendu » ; il ne revient en « qualifié » que par un nouveau banc réussi. Renvoie les (modèle, tâche) suspendus.
 */
export async function suspendFromObserved(now: Date = new Date()): Promise<{ modelId: string; task: string; rate: number }[]> {
  const since = new Date(+now - OBSERVED_WINDOW_DAYS * 86400_000).toISOString();
  // seuls les appels POSTÉRIEURS à la dernière évaluation comptent : un modèle requalifié par un nouveau banc repart d'un compteur vierge
  const rows: any = await db.execute(sql`
    SELECT t->>'model' AS model, r.prompt_id AS task,
           count(*) FILTER (WHERE t->>'outcome' = 'OK') AS ok,
           count(*) FILTER (WHERE t->>'outcome' IN ('INVALID_JSON', 'SCHEMA', 'TRUNCATED')) AS failed
    FROM agent_runs r
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.trace->'tried', '[]'::jsonb)) t
    JOIN llm_qualifications q ON q.model_id = t->>'model' AND q.task = r.prompt_id AND q.status = 'QUALIFIED'
    WHERE r.created_at >= ${since}::timestamptz AND r.created_at >= q.evaluated_at AND r.prompt_id IS NOT NULL
    GROUP BY 1, 2`);
  const suspended: { modelId: string; task: string; rate: number }[] = [];
  for (const row of rows.rows ?? rows) {
    const v = observedVerdict(Number(row.ok), Number(row.failed));
    if (!v.suspend || v.rate === null) continue;
    const res = await db.update(schema.llmQualifications).set({
      status: "SUSPENDED", reason: `échecs observés : ${Math.round(v.rate * 1000) / 10} % de réussite sur ${OBSERVED_WINDOW_DAYS} jours (${Number(row.ok)} sur ${Number(row.ok) + Number(row.failed)})`,
      details: { observed: { ok: Number(row.ok), failed: Number(row.failed), windowDays: OBSERVED_WINDOW_DAYS } }, evaluatedAt: now, evaluatedBy: "system",
    }).where(and(eq(schema.llmQualifications.modelId, row.model), eq(schema.llmQualifications.task, row.task), eq(schema.llmQualifications.status, "QUALIFIED"))).returning({ modelId: schema.llmQualifications.modelId });
    if (res.length) suspended.push({ modelId: row.model, task: row.task, rate: v.rate });
  }
  return suspended;
}
