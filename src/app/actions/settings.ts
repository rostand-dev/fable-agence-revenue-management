"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import type { FormState } from "@/components/forms";
import { AGENTS } from "@/lib/agents/registry";
import { requireUser } from "@/lib/auth";
import { missingEconomics } from "@/lib/engine/economics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import { parseMarkupList } from "@/lib/pricing/published";
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
  const draft = txt(fd, "intent") === "draft";
  const v = readProperty(fd);
  const err = check(v, draft);
  if (err) return { error: err };
  const mk = readMarkups(fd);
  if (!mk.ok) return { error: mk.error };
  const old = p.strategy as Strategy;
  const strategy: Strategy = { ...old, minStay: v.minStay, objective: v.objective, positioning: v.positioning, maxDiscountStackPct: old.maxDiscountStackPct ?? 20, maxPriceChangePct: old.maxPriceChangePct ?? 5 };
  const name = v.name || p.name || "Logement sans nom";
  await db.update(schema.properties).set({
    name, city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity, strategy, channelMarkups: mk.markups, profile: { ...p.profile, positioning: v.positioning ?? null },
  }).where(eq(schema.properties.id, p.id));
  await db.insert(schema.auditEvents).values({ id: newId("evt"), tenantId: u.tenantId, actor: "user:" + u.id, type: draft ? "property.draft_saved" : "property.updated", entity: "Property", entityId: p.id, summary: `${u.name} ${draft ? "enregistre sa saisie pour" : "met à jour le dossier de"} ${name}.` });
  // Une clé déjà enregistrée ne se remplace pas ici : elle se gère dans l'onglet de l'intégration.
  const plKey = p.pricelabs?.apiKeyEnc ? "" : txt(fd, "pricelabsKey"), shKey = p.superhote?.apiKeyEnc ? "" : txt(fd, "superhoteKey");
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
  await db.update(schema.tenants).set({ settings: { ...u.settings, agentNames: names } }).where(eq(schema.tenants.id, u.tenantId));
  revalidatePath("/", "layout");
  return { ok: "Prénoms enregistrés. Les rôles ne changent pas." };
}

export async function killSwitchAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const provider = txt(fd, "provider"), on = txt(fd, "on") === "1";
  await db.update(schema.integrations).set({ killSwitch: on }).where(and(eq(schema.integrations.tenantId, u.tenantId), eq(schema.integrations.provider, provider)));
  await db.insert(schema.auditEvents).values({ id: newId("evt"), tenantId: u.tenantId, actor: "user:" + u.id, type: on ? "integration.kill_switch_on" : "integration.kill_switch_off", entity: "Integration", entityId: provider, summary: `${u.name} ${on ? "active" : "lève"} le coupe-circuit ${provider}.` });
  revalidatePath("/integrations");
  return null;
}
