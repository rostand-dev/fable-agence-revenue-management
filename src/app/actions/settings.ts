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
import { connectPriceLabs, SyncError } from "@/lib/services/pricelabs-sync";

const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** Champ vide = inconnu (null), jamais zéro. */
const eur = (fd: FormData, k: string): number | null => { const v = txt(fd, k).replace(",", "."); if (v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
const num = (fd: FormData, k: string): number | null => { const v = txt(fd, k).replace(",", "."); if (v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

function readProperty(fd: FormData) {
  const channels: EconomicModel["channels"] = {};
  const a = num(fd, "airbnbCommission"), b = num(fd, "bookingCommission");
  if (a !== null) channels.AIRBNB = { commissionPct: a, paymentFeePct: 0 };
  if (b !== null) channels.BOOKING = { commissionPct: b, paymentFeePct: num(fd, "bookingPaymentFee") ?? 0 };
  const economics: EconomicModel = {
    channels, cleaningFeeChargedCents: eur(fd, "cleaningFee"), cleaningCostCents: eur(fd, "cleaningCost"), linenCostCents: eur(fd, "linenCost"), nightlyVariableCostCents: eur(fd, "variableCost"),
    hardContributionPerNightCents: eur(fd, "hardContribution"), strategyContributionPerNightCents: eur(fd, "strategyContribution"), targetContributionPerNightCents: eur(fd, "targetContribution"), origin: "DECLARED",
  };
  return { name: txt(fd, "name"), city: txt(fd, "city"), kind: txt(fd, "kind"), bedrooms: num(fd, "bedrooms"), capacity: num(fd, "capacity"), economics, minStay: num(fd, "minStay"), objective: txt(fd, "objective") || undefined, positioning: txt(fd, "positioning") || undefined };
}
function check(v: ReturnType<typeof readProperty>, draft: boolean): string | null {
  if (!draft && (v.name.length < 2 || v.city.length < 2 || !v.kind)) return "Le nom, la ville et le type du logement sont nécessaires pour créer le dossier. Pour vous arrêter ici, utilisez « Enregistrer et reprendre plus tard ».";
  const e = v.economics;
  if (e.hardContributionPerNightCents !== null && e.strategyContributionPerNightCents !== null && e.strategyContributionPerNightCents < e.hardContributionPerNightCents) return "La contribution de sécurité doit être au moins égale à la contribution minimale absolue.";
  return null;
}
const identityOk = (v: { name: string; city: string; kind: string }) => v.name.length >= 2 && v.city.length >= 2 && !!v.kind;

/** Création d'un logement. « draft » enregistre la saisie telle quelle, sans champ obligatoire, pour la reprendre plus tard. */
export async function createPropertyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const draft = txt(fd, "intent") === "draft";
  const v = readProperty(fd);
  const err = check(v, draft);
  if (err) return { error: err };
  const strategy: Strategy = { basePriceCents: null, minPriceCents: null, maxPriceCents: null, minStay: v.minStay, objective: v.objective, positioning: v.positioning, maxDiscountStackPct: 20, maxPriceChangePct: 5 };
  const miss = missingEconomics(v.economics);
  const complete = miss.length === 0 && identityOk(v);
  const id = newId("prop"), name = v.name || "Logement sans nom";
  await db.insert(schema.properties).values({ id, tenantId: u.tenantId, name, city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity, status: complete ? "SHADOW" : "ONBOARDING", isDemo: false, profile: { positioning: v.positioning ?? null, channels: Object.keys(v.economics.channels) }, economics: v.economics, strategy });
  await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: u.tenantId, agentId: "onboarding", operation: "onboard", mode: "DETERMINISTIC", summary: complete ? `${name} : dossier complet, planchers calculés. Le logement entre en période d'observation.` : draft ? `${name} : saisie enregistrée, à reprendre. Les valeurs non renseignées restent inconnues.` : `${name} : dossier créé, incomplet (${miss.join(", ")}). Ces valeurs restent inconnues tant que vous ne les avez pas fournies.` });
  await db.insert(schema.auditEvents).values({ id: newId("evt"), tenantId: u.tenantId, actor: "user:" + u.id, type: draft ? "property.draft_saved" : "property.created", entity: "Property", entityId: id, summary: `${u.name} ${draft ? "enregistre un brouillon de logement" : "ajoute le logement"} ${name}.` });
  // La clé PriceLabs est rattachée au logement : elle est vérifiée maintenant, le dossier est créé dans tous les cas.
  const key = txt(fd, "pricelabsKey");
  let plError = "";
  if (key) {
    try { await connectPriceLabs(u.tenantId, id, key, "user:" + u.id); }
    catch (e) { plError = e instanceof SyncError ? e.message : "Erreur technique pendant la connexion à PriceLabs."; }
  }
  revalidatePath("/", "layout");
  if (draft && !key) redirect(`/logements/${id}/modifier?enregistre=1`);
  redirect(`/logements/${id}?tab=pricelabs${plError ? "&erreur=" + encodeURIComponent(plError) : ""}`);
}

/** Reprise ou correction d'un dossier. Les prix de base, minimum et maximum lus dans PriceLabs ne sont pas touchés. */
export async function updatePropertyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const id = txt(fd, "propertyId");
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, u.tenantId)));
  if (!p) return { error: "Logement introuvable." };
  if (p.isDemo) return { error: "Un logement de démonstration ne se modifie pas." };
  const draft = txt(fd, "intent") === "draft";
  const v = readProperty(fd);
  const err = check(v, draft);
  if (err) return { error: err };
  const old = p.strategy as Strategy;
  const strategy: Strategy = { ...old, minStay: v.minStay, objective: v.objective, positioning: v.positioning, maxDiscountStackPct: old.maxDiscountStackPct ?? 20, maxPriceChangePct: old.maxPriceChangePct ?? 5 };
  const complete = missingEconomics(v.economics).length === 0 && identityOk(v);
  const econChanged = JSON.stringify({ ...v.economics, origin: 0 }) !== JSON.stringify({ ...(p.economics as any), origin: 0 });
  const name = v.name || p.name || "Logement sans nom";
  await db.update(schema.properties).set({
    name, city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity, economics: v.economics, strategy,
    profile: { ...p.profile, positioning: v.positioning ?? null, channels: Object.keys(v.economics.channels) },
    status: !complete ? "ONBOARDING" : p.status === "ONBOARDING" ? "SHADOW" : p.status, strategyVersion: econChanged && p.status !== "ONBOARDING" ? p.strategyVersion + 1 : p.strategyVersion,
  }).where(eq(schema.properties.id, p.id));
  await db.insert(schema.auditEvents).values({ id: newId("evt"), tenantId: u.tenantId, actor: "user:" + u.id, type: draft ? "property.draft_saved" : "property.updated", entity: "Property", entityId: p.id, summary: `${u.name} ${draft ? "enregistre sa saisie pour" : "met à jour le dossier de"} ${name}${econChanged ? " (modèle économique modifié : planchers recalculés)" : ""}.` });
  const key = txt(fd, "pricelabsKey");
  let plError = "";
  if (key && !p.pricelabs?.apiKeyEnc) {
    try { await connectPriceLabs(u.tenantId, p.id, key, "user:" + u.id); }
    catch (e) { plError = e instanceof SyncError ? e.message : "Erreur technique pendant la connexion à PriceLabs."; }
  }
  revalidatePath("/", "layout");
  if (plError || (key && !p.pricelabs?.apiKeyEnc)) redirect(`/logements/${p.id}?tab=pricelabs${plError ? "&erreur=" + encodeURIComponent(plError) : ""}`);
  if (draft) return { ok: "Saisie enregistrée. Vous pouvez fermer cette page et la reprendre plus tard depuis Logements." };
  redirect(`/logements/${p.id}?tab=${complete ? "economie" : "donnees"}`);
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
