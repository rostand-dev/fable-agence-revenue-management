"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor, type AuditType } from "@/lib/audit/types";
import type { FormState } from "@/components/forms";
import { AGENTS } from "@/lib/agents/registry";
import { LlmError } from "@/lib/agents/llm";
import { isProviderKey, listProviderModels, loadOwnerKeys, PROVIDER_LABEL, type OwnerKey } from "@/lib/agents/owner-keys";
import { catalogById, type ProviderKey } from "@/lib/llm-registry/catalog";
import { refreshAvailabilityForKey } from "@/lib/llm-registry/sync";
import { requireUser } from "@/lib/auth";
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
  const refused = await confirmPasswordIfNeeded(u, fd); // clé API : mot de passe redemandé si la session vient de « Rester connecté »
  if (refused) return refused;
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
  const refused = await confirmPasswordIfNeeded(u, fd);
  if (refused) return refused;
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
  redirect("/integrations?llm=supprimee");
}

/** Relit la liste des modèles d'un fournisseur avec la clé du propriétaire. */
async function refreshKeyModels(tenantId: string, prov: ProviderKey) {
  const k = (await loadOwnerKeys(tenantId)).get(prov);
  if (!k) throw new LlmError(`Aucune clé API ${PROVIDER_LABEL[prov]} enregistrée. Saisissez d'abord votre clé dans Intégrations.`);
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
  return run(async () => {
    const asked: Record<string, string> = {};
    for (const a of AGENTS) { const v = txt(fd, "model-" + a.id).slice(0, 120); if (v) asked[a.id] = v; }
    if (Object.keys(asked).length && (await loadOwnerKeys(u.tenantId)).size === 0) return { error: "Saisissez d'abord une clé API dans Intégrations : la liste des modèles dépend d'elle." };
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
  return run(async () => {
    const agentId = txt(fd, "agentId"), model = txt(fd, "model").slice(0, 120);
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) return { error: "Agent inconnu." };
    if (model) {
      if ((await loadOwnerKeys(u.tenantId)).size === 0) return { error: "Saisissez d'abord une clé API dans Intégrations : la liste des modèles dépend d'elle." };
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
