"use server";
import { commitStrategy } from "@/lib/services/strategy";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import type { FormState } from "@/components/forms";
import { AGENTS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { confirmPasswordIfNeeded } from "@/lib/reauth";
import { capabilitiesOf, capabilityFlags, isProvider, KILL_SWITCH_PROVIDERS, PROVIDER_INFO, type Provider } from "@/lib/integrations/capabilities";
import { missingEconomics } from "@/lib/engine/economics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import { PLAYBOOK_CODES } from "@/lib/engine/playbooks";
import { DEFAULT_SCORING, EXECUTION_MODES, RISKS, scoringOverrides, validateScoringInput } from "@/lib/engine/scoring";
import { parseMarkupList } from "@/lib/pricing/published";
import { FlagError, setFlag } from "@/lib/services/flags";
import { connectPriceLabs, SyncError } from "@/lib/services/pricelabs-sync";
import { connectSuperhote } from "@/lib/services/superhote-sync";

const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** Connexions facultatives saisies dans le dossier d'un logement lancé (clé absente) : chacune est vérifiée maintenant, une erreur n'empêche jamais la création du dossier. */
async function connectKeys(tenantId: string, propertyId: string, actor: string, plKey: string, shKey: string) {
  let plError = "", shError = "";
  if (plKey) { try { await connectPriceLabs(tenantId, propertyId, plKey, actor); } catch (e) { plError = e instanceof SyncError ? e.message : "Erreur technique pendant la connexion à PriceLabs."; } }
  if (shKey) { try { await connectSuperhote(tenantId, propertyId, shKey, actor); } catch (e) { shError = e instanceof SyncError ? e.message : "Erreur technique pendant la connexion à SuperHote."; } }
  return { plError, shError };
}
/** Où atterrir : PriceLabs d'abord (premier branchement), sinon SuperHote ; l'erreur de l'autre est rappelée dans le bandeau. */
function landing(id: string, plKey: string, shKey: string, plError: string, shError: string) {
  const q = (plError ? "&erreur=" + encodeURIComponent(plError) : "") + (shError ? "&erreurSh=" + encodeURIComponent(shError) : "");
  return `/logements/${id}?tab=${plKey ? "pricelabs" : "superhote"}${q}`;
}
/** Champ vide = inconnu (null), jamais zéro. */
const num = (fd: FormData, k: string): number | null => { const v = txt(fd, k).replace(",", "."); if (v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

/** Identité du logement (la création passe par le parcours guidé, actions/onboarding.ts). Coûts, commissions et seuils se renseignent dans le parcours « Coûts et seuils ». */
function readProperty(fd: FormData) {
  return { name: txt(fd, "name"), city: txt(fd, "city"), kind: txt(fd, "kind"), bedrooms: num(fd, "bedrooms"), capacity: num(fd, "capacity"), minStay: num(fd, "minStay"), objective: txt(fd, "objective") || undefined, positioning: txt(fd, "positioning") || undefined };
}
function check(v: ReturnType<typeof readProperty>, draft: boolean): string | null {
  if (!draft && (v.name.length < 2 || v.city.length < 2 || !v.kind)) return "Le nom, la ville et le type du logement sont nécessaires pour créer le dossier. Pour vous arrêter ici, utilisez « Enregistrer et reprendre plus tard ».";
  return null;
}
/** Majorations par canal : listes parallèles `markupLabel` / `markupPct`. Pourcentage vide = inconnu. */
const readMarkups = (fd: FormData) => parseMarkupList(fd.getAll("markupLabel").map(String), fd.getAll("markupPct").map(String));

/** Reprise ou correction d'un dossier. Les prix de base, minimum et maximum lus dans PriceLabs ne sont pas touchés. */
export async function updatePropertyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const id = txt(fd, "propertyId");
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, u.tenantId)));
  if (!p) return { error: "Logement introuvable." };
  if (p.isDemo) return { error: "Un logement de démonstration ne se modifie pas." };
  // le lancement (ONBOARDING → SHADOW) ne se fait qu'à la vérification du parcours guidé, PriceLabs connecté
  if (p.status === "ONBOARDING") return { error: "Ce logement est en cours de création : terminez-la dans le parcours guidé." };
  // une clé API saisie ici est une modification sensible : mot de passe redemandé (avant toute écriture) si la session vient de « Rester connecté »
  const plKey = p.pricelabs?.apiKeyEnc ? "" : txt(fd, "pricelabsKey"), shKey = p.superhote?.apiKeyEnc ? "" : txt(fd, "superhoteKey");
  if (plKey || shKey) { const refused = await confirmPasswordIfNeeded(u, fd); if (refused) return refused; }
  const draft = txt(fd, "intent") === "draft";
  const v = readProperty(fd);
  const err = check(v, draft);
  if (err) return { error: err };
  const mk = readMarkups(fd);
  if (!mk.ok) return { error: mk.error };
  // propriétaire du bien : de cet espace, sinon refus ; vide = inchangé
  const requestedOwner = txt(fd, "ownerId");
  if (requestedOwner) {
    const [o] = await db.select({ id: schema.owners.id }).from(schema.owners).where(and(eq(schema.owners.id, requestedOwner), eq(schema.owners.tenantId, u.tenantId)));
    if (!o) return { error: "Ce propriétaire n'existe pas dans votre espace." };
  }
  const old = p.strategy as Strategy;
  const name = v.name || p.name || "Logement sans nom";
  // le dossier et la version de stratégie s'écrivent ensemble : minStay, objectif et positionnement sont des réglages versionnés (US-023)
  let strategy = old;
  await db.transaction(async (tx) => {
    await tx.update(schema.properties).set({
      name, city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity, ...(requestedOwner ? { ownerId: requestedOwner } : {}), channelMarkups: mk.markups, profile: { ...p.profile, positioning: v.positioning ?? null },
    }).where(eq(schema.properties.id, p.id));
    const res = await commitStrategy(tx, { tenantId: u.tenantId, propertyId: p.id, next: (s) => ({ ...s, minStay: v.minStay, objective: v.objective, positioning: v.positioning, maxDiscountStackPct: s.maxDiscountStackPct ?? 20, maxPriceChangePct: s.maxPriceChangePct ?? 5 }), source: "FORM", createdBy: u.id });
    if (res) strategy = res.strategy;
  });
  const next: Record<string, unknown> = { name, city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity };
  const changed: string[] = Object.keys(next).filter((k) => ((p as Record<string, unknown>)[k] ?? null) !== (next[k] ?? null));
  if (requestedOwner && requestedOwner !== p.ownerId) changed.push("ownerId");
  if (old.minStay !== strategy.minStay) changed.push("minStay");
  if (JSON.stringify(p.channelMarkups) !== JSON.stringify(mk.markups)) changed.push("channelMarkups");
  await recordAudit(db, { tenantId: u.tenantId, actor: userActor(u.id), type: draft ? "property.draft_saved" : "property.updated", entity: "Property", entityId: p.id, summary: `${u.name} ${draft ? "enregistre sa saisie pour" : "met à jour le dossier de"} ${name}.`, payload: { changed } });
  // Une clé déjà enregistrée ne se remplace pas ici : elle se gère dans l'onglet de l'intégration.
  const { plError, shError } = await connectKeys(u.tenantId, p.id, "user:" + u.id, plKey, shKey);
  revalidatePath("/", "layout");
  if (plKey || shKey) redirect(landing(p.id, plKey, shKey, plError, shError));
  if (draft) return { ok: "Saisie enregistrée. Vous pouvez fermer cette page et la reprendre plus tard depuis Logements." };
  if (missingEconomics(p.economics as EconomicModel).length) redirect(`/logements/${p.id}/couts`);
  redirect(`/logements/${p.id}`);
}

export async function renameAgentsAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const names: Record<string, string> = {};
  for (const a of AGENTS) { const v = txt(fd, "agent-" + a.id).slice(0, 24); if (v && v !== a.name) names[a.id] = v; }
  await db.transaction(async (tx) => {
  await tx.update(schema.tenants).set({ settings: { ...u.settings, agentNames: names } }).where(eq(schema.tenants.id, u.tenantId));
  await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "settings.agents_renamed", entity: "Tenant", entityId: u.tenantId, summary: `${u.name} modifie les prénoms de l'équipe${Object.keys(names).length ? "" : " (retour aux prénoms d'origine)"}.`, payload: { from: u.settings.agentNames ?? {}, to: names } });
  });
  revalidatePath("/", "layout");
  return { ok: "Prénoms enregistrés. Les rôles ne changent pas." };
}

/** Priorisation des dossiers (US-062) : poids par playbook, pénalités de risque, coûts d'exécution. Seuls les écarts au réglage par défaut sont enregistrés. */
export async function saveScoringAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const group = (prefix: string, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, txt(fd, `${prefix}-${k}`)]).filter(([, v]) => v !== ""));
  const reset = txt(fd, "reset") === "1";
  const checked = reset ? { ok: true as const, config: DEFAULT_SCORING } : validateScoringInput({ strategicWeight: group("w", PLAYBOOK_CODES), riskPenalty: group("r", RISKS), executionCost: group("c", EXECUTION_MODES) });
  if (!checked.ok) return { error: checked.error };
  const overrides = scoringOverrides(checked.config);
  const previous = u.settings.scoring ?? {};
  const { scoring: _old, ...rest } = u.settings;
  await db.transaction(async (tx) => {
    await tx.update(schema.tenants).set({ settings: Object.keys(overrides).length ? { ...rest, scoring: overrides } : rest }).where(eq(schema.tenants.id, u.tenantId));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "settings.scoring_updated", entity: "Tenant", entityId: u.tenantId, summary: `${u.name} ${Object.keys(overrides).length ? "modifie la priorisation des dossiers" : "rétablit la priorisation par défaut"}.`, payload: { from: previous, to: overrides } });
  });
  revalidatePath("/", "layout");
  return { ok: "Priorisation enregistrée. Elle s'applique à la prochaine revue des logements." };
}

/** Capacités d'un fournisseur sur un logement réel, pour la ligne créée par le coupe-circuit */
const realFlags = (provider: Provider) => { const f = capabilityFlags({ isDemo: false, killSwitch: {} }); return Object.fromEntries(capabilitiesOf(provider).map((c) => [c.id, f[c.id]])); };

export async function killSwitchAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const provider = txt(fd, "provider"), on = txt(fd, "on") === "1";
  // seuls les fournisseurs du catalogue ont un coupe-circuit : aucune ligne ni audit pour un nom inventé
  if (!isProvider(provider) || (on && !KILL_SWITCH_PROVIDERS.includes(provider))) return { error: "Intégration inconnue." };
  // une ligne est créée au besoin (un compte réel n'en a pas encore) : le coupe-circuit agit toujours, jamais en silence ; rejouable sans erreur
  await db.transaction(async (tx) => {
  await tx.insert(schema.integrations).values({
    id: newId("int"), tenantId: u.tenantId, provider, status: "NOT_CONNECTED", killSwitch: on,
    capabilities: realFlags(provider),
  }).onConflictDoUpdate({ target: [schema.integrations.tenantId, schema.integrations.provider], set: { killSwitch: on } });
  await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: on ? "integration.kill_switch_on" : "integration.kill_switch_off", entity: "Integration", entityId: provider, summary: `${u.name} ${on ? "active" : "lève"} le coupe-circuit ${PROVIDER_INFO[provider].name}.`, payload: { provider, on } });
  });
  revalidatePath("/", "layout");
  return null;
}

/** Active ou désactive une fonction à un niveau (propriétaire, logement, intégration) : US-013, journalisé dans la même transaction. */
export async function setFlagAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const en = txt(fd, "enabled"), flag = txt(fd, "flag"), scope = txt(fd, "scope"), scopeId = txt(fd, "scopeId");
  if ((en !== "0" && en !== "1") || flag.length > 40 || scope.length > 20 || scopeId.length > 80) return { error: "Demande invalide." };
  try {
    const r = await setFlag(u, { flag, scope, scopeId, enabled: en === "1" });
    revalidatePath("/", "layout");
    return { ok: r === "changed" ? "Réglage enregistré." : "Déjà dans cet état." };
  } catch (e) {
    if (e instanceof FlagError) return { error: e.message };
    throw e;
  }
}
