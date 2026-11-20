"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor, type AuditType } from "@/lib/audit/types";
import type { FormState } from "@/components/forms";
import { AGENTS } from "@/lib/agents/registry";
import { LlmError, listAnthropicModels } from "@/lib/agents/llm";
import { requireUser } from "@/lib/auth";
import { confirmPasswordIfNeeded } from "@/lib/reauth";
import { decryptSecret, encryptSecret, secretHint } from "@/lib/secret";

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

/** Enregistre la clé après l'avoir vérifiée : elle doit pouvoir lister des modèles. Jamais réaffichée en entier. */
export async function saveLlmKeyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const refused = await confirmPasswordIfNeeded(u, fd); // clé API : mot de passe redemandé si la session vient de « Rester connecté »
  if (refused) return refused;
  return run(async () => {
    const key = txt(fd, "apiKey");
    if (key.length < 20) return { error: "La clé semble incomplète. Copiez-la en entier depuis la console Anthropic." };
    const models = await listAnthropicModels(key);
    if (!models.length) return { error: "Cette clé est valide mais ne donne accès à aucun modèle. Vérifiez son espace de travail dans la console Anthropic." };
    const enc = encryptSecret(key), now = new Date();
    const row = { provider: "anthropic", apiKeyEnc: enc, keyHint: secretHint(key), models, modelsFetchedAt: now, verifiedAt: now, updatedAt: now };
    await db.insert(schema.llmCredentials).values({ tenantId: u.tenantId, ...row }).onConflictDoUpdate({ target: schema.llmCredentials.tenantId, set: row });
    // un choix de modèle que la nouvelle clé ne peut pas utiliser est retiré, pour ne jamais envoyer un modèle inaccessible
    const ids = new Set(models.map((m) => m.id));
    await patchSettings(u.tenantId, (s) => ({ ...s, agentModels: Object.fromEntries(Object.entries((s.agentModels ?? {}) as Record<string, string>).filter(([, v]) => ids.has(v))) }));
    await audit(u.tenantId, u.id, "llm.key_saved", `${u.name} enregistre sa clé API Anthropic (${secretHint(key)}), ${models.length} modèle${models.length > 1 ? "s" : ""} disponible${models.length > 1 ? "s" : ""}.`, { keyHint: secretHint(key), models: models.length });
    revalidatePath("/", "layout");
    return { ok: `Clé vérifiée : ${models.length} modèle${models.length > 1 ? "s" : ""} disponible${models.length > 1 ? "s" : ""}.` };
  });
}

export async function removeLlmKeyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const refused = await confirmPasswordIfNeeded(u, fd);
  if (refused) return refused;
  const res = await run(async () => {
    await db.delete(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, u.tenantId));
    await patchSettings(u.tenantId, (s) => { const { agentModels, ...rest } = s; return rest; });
    await audit(u.tenantId, u.id, "llm.key_removed", `${u.name} supprime sa clé API Anthropic et les modèles choisis par agent.`);
    revalidatePath("/", "layout");
    return null;
  });
  // le formulaire de suppression disparaît avec la clé : la confirmation s'affiche donc sur la page, après redirection
  if (res?.error) return res;
  redirect("/integrations?llm=supprimee");
}

async function userKeyAndRefresh(tenantId: string) {
  const [c] = await db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, tenantId));
  if (!c) throw new LlmError("Aucune clé API enregistrée. Saisissez d'abord votre clé dans Intégrations.");
  let key: string;
  try { key = decryptSecret(c.apiKeyEnc); } catch { throw new LlmError("Clé illisible (APP_SECRET a changé ?). Saisissez-la de nouveau."); }
  const models = await listAnthropicModels(key), now = new Date();
  await db.update(schema.llmCredentials).set({ models, modelsFetchedAt: now, verifiedAt: now, updatedAt: now }).where(eq(schema.llmCredentials.tenantId, tenantId));
  return models;
}

export async function refreshModelsAction(_: FormState, __: FormData): Promise<FormState> {
  const u = await requireUser();
  return run(async () => {
    const models = await userKeyAndRefresh(u.tenantId);
    await audit(u.tenantId, u.id, "llm.models_refreshed", `${u.name} actualise la liste des modèles Anthropic (${models.length} disponible${models.length > 1 ? "s" : ""}).`, { models: models.length });
    revalidatePath("/", "layout");
    return { ok: `Liste actualisée : ${models.length} modèle${models.length > 1 ? "s" : ""} disponible${models.length > 1 ? "s" : ""}.` };
  });
}

/** Un modèle par agent. Chaque valeur doit figurer dans la liste des modèles de la clé ; vide = modèle par défaut du serveur. */
export async function saveAgentModelsAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  return run(async () => {
    const asked: Record<string, string> = {};
    for (const a of AGENTS) { const v = txt(fd, "model-" + a.id).slice(0, 120); if (v) asked[a.id] = v; }
    const [c] = await db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, u.tenantId));
    if (Object.keys(asked).length && !c) return { error: "Saisissez d'abord votre clé API dans Intégrations : la liste des modèles dépend d'elle." };
    let ids = new Set((c?.models ?? []).map((m) => m.id));
    // modèle absent du cache : la liste a peut-être changé, on la relit une fois avant de refuser
    if (Object.values(asked).some((v) => !ids.has(v))) ids = new Set((await userKeyAndRefresh(u.tenantId)).map((m) => m.id));
    const bad = AGENTS.filter((a) => asked[a.id] && !ids.has(asked[a.id]));
    if (bad.length) return { error: `Modèle indisponible avec votre clé pour : ${bad.map((a) => a.title).join(", ")}. Choisissez-en un dans la liste.` };
    await patchSettings(u.tenantId, (s) => ({ ...s, agentModels: asked }));
    await audit(u.tenantId, u.id, "llm.models_saved", `${u.name} choisit le modèle de ${Object.keys(asked).length} agent${Object.keys(asked).length > 1 ? "s" : ""}.`, { models: asked });
    revalidatePath("/", "layout");
    return { ok: "Modèles enregistrés." };
  });
}

/** Fiche agent : change le modèle d'un seul agent sans toucher aux autres. */
export async function saveAgentModelAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  return run(async () => {
    const agentId = txt(fd, "agentId"), model = txt(fd, "model").slice(0, 120);
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!agent) return { error: "Agent inconnu." };
    if (model) {
      const [c] = await db.select().from(schema.llmCredentials).where(eq(schema.llmCredentials.tenantId, u.tenantId));
      if (!c) return { error: "Saisissez d'abord votre clé API dans Intégrations : la liste des modèles dépend d'elle." };
      let ids = new Set(c.models.map((m) => m.id));
      if (!ids.has(model)) ids = new Set((await userKeyAndRefresh(u.tenantId)).map((m) => m.id));
      if (!ids.has(model)) return { error: "Ce modèle n'est pas disponible avec votre clé. Choisissez-en un dans la liste." };
    }
    await patchSettings(u.tenantId, (s) => {
      const cur = { ...((s.agentModels ?? {}) as Record<string, string>) };
      if (model) cur[agentId] = model; else delete cur[agentId];
      return { ...s, agentModels: cur };
    });
    await audit(u.tenantId, u.id, "llm.model_saved", `${u.name} change le modèle de ${agent.title}.`, { agentId, model: model || null });
    revalidatePath("/", "layout");
    return { ok: model ? "Modèle enregistré." : "Cet agent reprend le modèle par défaut." };
  });
}
