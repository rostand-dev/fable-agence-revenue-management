"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor, type AuditType } from "@/lib/audit/types";
import type { FormState } from "@/components/forms";
import { AGENTS } from "@/lib/agents/registry";
import { LlmError } from "@/lib/agents/llm";
import { isProviderKey, listProviderModels, loadOwnerKeys, PROVIDER_LABEL, type OwnerKey } from "@/lib/agents/owner-keys";
import { catalogById, type ProviderKey } from "@/lib/llm-registry/catalog";
import { runBench } from "@/lib/llm-registry/bench";
import { ADMIN_ONLY_MESSAGE, isLlmAdmin } from "@/lib/llm-registry/admin";
import { BENCH_AGENT_ID, benchPreflight } from "@/lib/llm-registry/bench-guard";
import { parseMonthlyCapEur, setMonthlyCapEur, usdToEur } from "@/lib/llm-registry/cap";
import { rejectPendingPrice, validatePendingPrice } from "@/lib/llm-registry/price-validation";
import { refreshAvailabilityForKey } from "@/lib/llm-registry/sync";
import { requireUser } from "@/lib/auth";
import { refused } from "@/lib/rights";
import { confirmPasswordIfNeeded } from "@/lib/reauth";
import { encryptSecret, secretHint } from "@/lib/secret";

const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Erreurs métier affichées près du formulaire ; tout le reste est journalisé côté serveur sans détail pour le navigateur. */
async function run(fn: () => Promise<FormState>): Promise<FormState> {
  try { return await fn(); }
  catch (e: any) {
    if (e instanceof LlmError) return { error: e.message };
    if (String(e?.message ?? "").startsWith("APP_SECRET manquant")) return { error: e.message };
    console.error("[llm-settings]", e?.name, e?.message);
    return { error: "Une erreur est survenue. Réessayez dans un instant." };
  }
}

/** Réglages du propriétaire relus juste avant l'écriture : on ne fusionne jamais sur une copie périmée. */
async function patchSettings(tenantId: string, patch: (s: Record<string, any>) => Record<string, any>) {
  const [t] = await db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  await db.update(schema.tenants).set({ settings: patch({ ...(t?.settings ?? {}) }) }).where(eq(schema.tenants.id, tenantId));
}
const audit = (tenantId: string, userId: string, type: AuditType, summary: string, payload?: unknown) =>
  recordAudit(db, { tenantId, actor: userActor(userId), type, entity: "LlmCredentials", entityId: tenantId, summary, payload });

const provider = (fd: FormData): ProviderKey => { const p = txt(fd, "provider") || "anthropic"; if (!isProviderKey(p)) throw new LlmError("Fournisseur inconnu."); return p; };
const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? "s" : ""}`;
const CONSOLE: Record<ProviderKey, string> = { anthropic: "la console Anthropic", openai: "la plateforme OpenAI", mistral: "la console Mistral" };

/** Identifiants de modèles accessibles avec au moins une clé du propriétaire (un choix manuel doit toujours en faire partie). */
const idsOf = (keys: Map<ProviderKey, OwnerKey>) => new Set([...keys.values()].flatMap((k) => k.models.map((m) => m.id)));

/** Retire les choix manuels de modèle que les clés restantes ne peuvent plus servir : on n'envoie jamais un modèle inaccessible. */
async function pruneAgentModels(tenantId: string) {
  const ids = idsOf(await loadOwnerKeys(tenantId));
  await patchSettings(tenantId, (s) => ({ ...s, agentModels: Object.fromEntries(Object.entries((s.agentModels ?? {}) as Record<string, string>).filter(([, v]) => ids.has(v))) }));
}

/** Enregistre la clé d'un fournisseur après l'avoir vérifiée : elle doit pouvoir lister des modèles. Jamais réaffichée en entier. Une clé par fournisseur. */
export async function saveLlmKeyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "workspace.manage"); if (no) return no;
  const reauth = await confirmPasswordIfNeeded(u, fd); // clé API : mot de passe redemandé si la session vient de « Rester connecté »
  if (reauth) return reauth;
  return run(async () => {
    const prov = provider(fd), label = PROVIDER_LABEL[prov];
    const key = txt(fd, "apiKey");
    if (key.length < 20) return { error: `La clé semble incomplète. Copiez-la en entier depuis ${CONSOLE[prov]}.` };
    const models = await listProviderModels(prov, key);
    if (!models.length) return { error: `Cette clé est valide mais ne donne accès à aucun modèle. Vérifiez son espace de travail dans ${CONSOLE[prov]}.` };
    const enc = encryptSecret(key), now = new Date();
    const row = { apiKeyEnc: enc, keyHint: secretHint(key), models, modelsFetchedAt: now, verifiedAt: now, updatedAt: now };
    await db.insert(schema.llmCredentials).values({ tenantId: u.tenantId, provider: prov, ...row }).onConflictDoUpdate({ target: [schema.llmCredentials.tenantId, schema.llmCredentials.provider], set: row });
    await pruneAgentModels(u.tenantId);
    // registre LLM : relecture de la disponibilité des modèles avec cette clé (sans attendre, sans jamais échouer)
    void refreshAvailabilityForKey(prov, key);
    await audit(u.tenantId, u.id, "llm.key_saved", `${u.name} enregistre sa clé API ${label} (${secretHint(key)}), ${plural(models.length, "modèle")} disponible${models.length > 1 ? "s" : ""}.`, { provider: prov, keyHint: secretHint(key), models: models.length });
    revalidatePath("/", "layout");
    return { ok: `Clé ${label} vérifiée : ${plural(models.length, "modèle")} disponible${models.length > 1 ? "s" : ""}.` };
  });
}

export async function removeLlmKeyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "workspace.manage"); if (no) return no;
  const reauth = await confirmPasswordIfNeeded(u, fd);
  if (reauth) return reauth;
  const res = await run(async () => {
    const prov = provider(fd);
    await db.delete(schema.llmCredentials).where(and(eq(schema.llmCredentials.tenantId, u.tenantId), eq(schema.llmCredentials.provider, prov)));
    await pruneAgentModels(u.tenantId);
    await audit(u.tenantId, u.id, "llm.key_removed", `${u.name} supprime sa clé API ${PROVIDER_LABEL[prov]} et les choix de modèle qui en dépendaient.`, { provider: prov });
    revalidatePath("/", "layout");
    return null;
  });
  // le formulaire de suppression disparaît avec la clé : la confirmation s'affiche donc sur la page, après redirection
  if (res?.error) return res;
  redirect("/modeles/cles?llm=supprimee");
}

/** Relit la liste des modèles d'un fournisseur avec la clé du propriétaire. */
async function refreshKeyModels(tenantId: string, prov: ProviderKey) {
  const k = (await loadOwnerKeys(tenantId)).get(prov);
  if (!k) throw new LlmError(`Aucune clé API ${PROVIDER_LABEL[prov]} enregistrée. Saisissez d'abord votre clé dans IA & modèles › Clés fournisseurs.`);
  const models = await listProviderModels(prov, k.apiKey), now = new Date();
  await db.update(schema.llmCredentials).set({ models, modelsFetchedAt: now, verifiedAt: now, updatedAt: now }).where(and(eq(schema.llmCredentials.tenantId, tenantId), eq(schema.llmCredentials.provider, prov)));
  return models;
}
/** Identifiants de modèles accessibles avec les clés du propriétaire ; relus une fois chez chaque fournisseur si un modèle demandé manque (la liste a pu changer). */
async function accessibleIds(tenantId: string, wanted: string[]): Promise<Set<string>> {
  let keys = await loadOwnerKeys(tenantId), ids = idsOf(keys);
  const missing = wanted.filter((v) => !ids.has(v));
  if (missing.length) {
    // relecture du seul fournisseur du modèle demandé (catalogue), sinon de chacun ; la panne d'un fournisseur n'empêche pas d'enregistrer un modèle d'un autre
    const provs = new Set<ProviderKey>(missing.flatMap((m) => { const c = catalogById(m); return c ? [c.provider] : [...keys.keys()]; }));
    for (const p of provs) if (keys.has(p)) { try { await refreshKeyModels(tenantId, p); } catch { /* liste conservée */ } }
    keys = await loadOwnerKeys(tenantId); ids = idsOf(keys);
  }
  return ids;
}

export async function refreshModelsAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "workspace.manage"); if (no) return no;
  return run(async () => {
    const prov = provider(fd);
    const models = await refreshKeyModels(u.tenantId, prov);
    await pruneAgentModels(u.tenantId);
    await audit(u.tenantId, u.id, "llm.models_refreshed", `${u.name} actualise la liste des modèles ${PROVIDER_LABEL[prov]} (${plural(models.length, "disponible")}).`, { provider: prov, models: models.length });
    revalidatePath("/", "layout");
    return { ok: `Liste ${PROVIDER_LABEL[prov]} actualisée : ${plural(models.length, "modèle")} disponible${models.length > 1 ? "s" : ""}.` };
  });
}

/** Un modèle par agent, ou « Automatique » (vide). Chaque choix doit figurer dans la liste des modèles d'une clé du propriétaire ; il prime toujours sur le routeur. */
export async function saveAgentModelsAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "workspace.manage"); if (no) return no;
  return run(async () => {
    const asked: Record<string, string> = {};
    for (const a of AGENTS) { const v = txt(fd, "model-" + a.id).slice(0, 120); if (v) asked[a.id] = v; }
    if (Object.keys(asked).length && (await loadOwnerKeys(u.tenantId)).size === 0) return { error: "Saisissez d'abord une clé API dans IA & modèles › Clés fournisseurs : la liste des modèles dépend d'elle." };
    const ids = await accessibleIds(u.tenantId, Object.values(asked));
    const bad = AGENTS.filter((a) => asked[a.id] && !ids.has(asked[a.id]));
    if (bad.length) return { error: `Modèle indisponible avec vos clés pour : ${bad.map((a) => a.title).join(", ")}. Choisissez-en un dans la liste.` };
    await patchSettings(u.tenantId, (s) => ({ ...s, agentModels: asked }));
    await audit(u.tenantId, u.id, "llm.models_saved", `${u.name} choisit le modèle de ${plural(Object.keys(asked).length, "agent")}.`, { models: asked });
    revalidatePath("/", "layout");
    return { ok: "Modèles enregistrés." };
  });
}

/** Fiche agent : change le modèle d'un seul agent sans toucher aux autres. Vide = Automatique. */
export async function saveAgentModelAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "workspace.manage"); if (no) return no;
  return run(async () => {
    const agentId = txt(fd, "agentId"), model = txt(fd, "model").slice(0, 120);
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) return { error: "Agent inconnu." };
    if (model) {
      if ((await loadOwnerKeys(u.tenantId)).size === 0) return { error: "Saisissez d'abord une clé API dans IA & modèles › Clés fournisseurs : la liste des modèles dépend d'elle." };
      if (!(await accessibleIds(u.tenantId, [model])).has(model)) return { error: "Ce modèle n'est pas disponible avec vos clés. Choisissez-en un dans la liste." };
    }
    await patchSettings(u.tenantId, (s) => {
      const cur = { ...((s.agentModels ?? {}) as Record<string, string>) };
      if (model) cur[agentId] = model; else delete cur[agentId];
      return { ...s, agentModels: cur };
    });
    await audit(u.tenantId, u.id, "llm.model_saved", `${u.name} change le modèle de ${agent.title}.`, { agentId, model: model || null });
    revalidatePath("/", "layout");
    return { ok: model ? "Modèle enregistré." : "Cet agent repasse en mode automatique." };
  });
}

/** Plafond mensuel de dépense des modèles, en euros. Vide = aucun plafond. À 100 %, les agents repassent en mode déterministe jusqu'au 1er du mois suivant (UTC). Réservé aux rôles qui administrent l'espace ; mot de passe redemandé si la session vient de « Rester connecté ». */
export async function saveMonthlyCapAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "workspace.manage"); if (no) return no;
  const reauth = await confirmPasswordIfNeeded(u, fd);
  if (reauth) return reauth;
  return run(async () => {
    const p = parseMonthlyCapEur(txt(fd, "cap"));
    if (!p.ok) return { error: p.error };
    await setMonthlyCapEur(u.tenantId, p.value);
    await audit(u.tenantId, u.id, "llm.cap_saved", p.value === null ? `${u.name} retire le plafond mensuel de dépense des modèles.` : `${u.name} fixe le plafond mensuel de dépense des modèles à ${p.value.toLocaleString("fr-FR")} €.`, { capEur: p.value });
    revalidatePath("/", "layout");
    return { ok: p.value === null ? "Plafond retiré : aucune limite de dépense." : `Plafond enregistré : ${p.value.toLocaleString("fr-FR")} € par mois.` };
  });
}

/**
 * Validation (ou refus) du nouveau prix d'un modèle. Le prix validé sert au routage et au plafond de TOUS les comptes : réservé à l'exploitant (LLM_ADMIN_EMAILS).
 * Porte sur le relevé que la personne a vu (snapshotId) ; un relevé plus récent exige un nouveau clic. Le prix en attente ne sert à aucun calcul avant validation.
 */
export async function decidePriceAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  if (!isLlmAdmin(u.email)) return { error: ADMIN_ONLY_MESSAGE };
  let outcome = "";
  const res = await run(async () => {
    const modelId = txt(fd, "modelId"), snapshotId = txt(fd, "snapshotId") || undefined, accept = txt(fd, "decision") === "valider";
    const m = catalogById(modelId);
    if (!m) return { error: "Modèle inconnu." };
    const done = accept ? await validatePendingPrice(modelId, u.id, new Date(), snapshotId) : await rejectPendingPrice(modelId, u.id, new Date(), snapshotId);
    if (!done) return { error: "Le prix en attente a changé ou a déjà été traité. Rechargez la page pour voir le prix actuel." };
    await audit(u.tenantId, u.id, accept ? "llm.price_validated" : "llm.price_rejected", `${u.name} ${accept ? "valide" : "refuse"} le changement de prix de ${m.label}.`, { modelId, snapshotId: snapshotId ?? null });
    outcome = accept ? "valide" : "refuse";
    revalidatePath("/", "layout");
    return null;
  });
  if (res?.error) return res;
  // le bloc « à valider » disparaît avec le prix en attente : la confirmation s'affiche donc sur la page, après redirection
  redirect(`/modeles/catalogue?prix=${outcome}`);
}

/**
 * Bouton « Tester ce modèle » : banc sur cas synthétiques (aucune donnée de logement envoyée) avec la clé de l'exploitant qui clique.
 * Le verdict de qualification est PARTAGÉ par tous les comptes : déclenchement réservé à l'exploitant (LLM_ADMIN_EMAILS).
 * Le coût estimé est montré avant le clic ; le coût réel est tracé (agent_runs, ligne « banc ») et compte dans le plafond mensuel, même si le test est interrompu.
 * Refusé si le prix est inconnu, si le plafond est atteint ou serait dépassé (au pire des cas), ou si la cadence est dépassée. Contrôles et pose de la trace sont atomiques par espace.
 */
export async function benchModelAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  if (!isLlmAdmin(u.email)) return { error: ADMIN_ONLY_MESSAGE };
  return run(async () => {
    const t0 = Date.now(), runId = newId("run");
    // verrou par espace : deux clics ou deux onglets ne passent pas les contrôles en même temps (la trace « en cours » est visible du second avant qu'il ne contrôle)
    const pre = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${u.tenantId + ":bench"}))`);
      const p = await benchPreflight(u.tenantId, txt(fd, "modelId"));
      if (!p.ok) return p;
      await tx.insert(schema.agentRuns).values({
        id: runId, tenantId: u.tenantId, agentId: BENCH_AGENT_ID, operation: "bench", mode: "LLM", model: p.model.modelId, provider: p.model.provider,
        summary: `Test de ${p.model.label} en cours.`, costEstimatedUsd: String(Math.round(p.maxUsd * 1e6) / 1e6), durationMs: 0,
      });
      return p;
    });
    if (!pre.ok) return { error: pre.error };
    const { model: m, key, maxUsd } = pre;
    const round = (v: number) => String(Math.round(v * 1e6) / 1e6);
    let out: Awaited<ReturnType<typeof runBench>>;
    try { out = await runBench({ modelId: m.modelId, apiKey: key.apiKey, evaluatedBy: u.id }); }
    catch (e: any) {
      // incident pendant le test : l'argent a pu être dépensé, la ligne garde donc l'estimation maximale (comptée dans le plafond) et l'incident est tracé
      await db.update(schema.agentRuns).set({ summary: `Test de ${m.label} interrompu par un incident.`, error: String(e?.message ?? e).slice(0, 200), durationMs: Date.now() - t0 }).where(eq(schema.agentRuns.id, runId));
      throw e;
    }
    const costUsd = out.costUsd ?? null;
    const okN = out.ok ? out.results.filter((r) => r.status === "QUALIFIED").length : 0;
    // coût réel tracé dans tous les cas (même interrompu) ; prix inconnu en cours de route = estimation maximale conservée
    await db.update(schema.agentRuns).set({
      summary: out.ok ? `Test de ${m.label} : ${okN} tâche(s) qualifiée(s) sur ${out.results.length}.` : `Test de ${m.label} interrompu.`,
      costUsd: costUsd === null ? null : round(costUsd), durationMs: Date.now() - t0, error: out.ok ? null : out.error,
    }).where(eq(schema.agentRuns.id, runId));
    const eur = costUsd === null ? "" : ` Coût réel ≈ ${usdToEur(costUsd).toLocaleString("fr-FR", { maximumFractionDigits: 4 })} €.`;
    if (!out.ok) {
      await audit(u.tenantId, u.id, "llm.bench_failed", `${u.name} teste ${m.label} : test interrompu.${eur}`, { modelId: m.modelId, costUsd, maxUsd });
      revalidatePath("/", "layout");
      return { error: `${out.error}${eur}` };
    }
    await audit(u.tenantId, u.id, "llm.bench_run", `${u.name} teste ${m.label} : ${okN} tâche${okN > 1 ? "s" : ""} qualifiée${okN > 1 ? "s" : ""} sur ${out.results.length}.${eur}`, { modelId: m.modelId, results: out.results, costUsd });
    revalidatePath("/", "layout");
    return { ok: `Test terminé : ${okN} tâche${okN > 1 ? "s" : ""} qualifiée${okN > 1 ? "s" : ""} sur ${out.results.length}.${eur}` };
  });
}
