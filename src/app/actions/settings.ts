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
import { runDailyReview } from "@/lib/services/review";

const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** Champ vide = inconnu (null), jamais zéro. */
const eur = (fd: FormData, k: string): number | null => { const v = txt(fd, k).replace(",", "."); if (v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
const num = (fd: FormData, k: string): number | null => { const v = txt(fd, k).replace(",", "."); if (v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

export async function createPropertyAction(_: FormState, fd: FormData): Promise<FormState> {
  const u = await requireUser();
  const name = txt(fd, "name"), city = txt(fd, "city"), kind = txt(fd, "kind");
  if (name.length < 2 || city.length < 2 || !kind) return { error: "Le nom, la ville et le type du logement sont nécessaires pour créer le dossier." };
  const channels: EconomicModel["channels"] = {};
  const a = num(fd, "airbnbCommission"), b = num(fd, "bookingCommission");
  if (a !== null) channels.AIRBNB = { commissionPct: a, paymentFeePct: 0 };
  if (b !== null) channels.BOOKING = { commissionPct: b, paymentFeePct: num(fd, "bookingPaymentFee") ?? 0 };
  const economics: EconomicModel = {
    channels, cleaningFeeChargedCents: eur(fd, "cleaningFee"), cleaningCostCents: eur(fd, "cleaningCost"), linenCostCents: eur(fd, "linenCost"), nightlyVariableCostCents: eur(fd, "variableCost"),
    hardContributionPerNightCents: eur(fd, "hardContribution"), strategyContributionPerNightCents: eur(fd, "strategyContribution"), targetContributionPerNightCents: eur(fd, "targetContribution"), origin: "DECLARED",
  };
  if (economics.hardContributionPerNightCents !== null && economics.strategyContributionPerNightCents !== null && economics.strategyContributionPerNightCents < economics.hardContributionPerNightCents)
    return { error: "La contribution de sécurité doit être au moins égale à la contribution minimale absolue." };
  const strategy: Strategy = { basePriceCents: eur(fd, "basePrice"), minPriceCents: eur(fd, "minPrice"), maxPriceCents: eur(fd, "maxPrice"), minStay: num(fd, "minStay"), objective: txt(fd, "objective") || undefined, positioning: txt(fd, "positioning") || undefined, maxDiscountStackPct: 20, maxPriceChangePct: 5 };
  const complete = missingEconomics(economics).length === 0;
  const id = newId("prop");
  await db.insert(schema.properties).values({ id, tenantId: u.tenantId, name, city, kind, bedrooms: num(fd, "bedrooms"), capacity: num(fd, "capacity"), status: complete ? "SHADOW" : "ONBOARDING", isDemo: false, profile: { positioning: strategy.positioning ?? null, channels: Object.keys(channels) }, economics, strategy });
  await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: u.tenantId, agentId: "onboarding", operation: "onboard", mode: "DETERMINISTIC", summary: complete ? `${name} : dossier complet, planchers calculés. Le logement entre en période d'observation.` : `${name} : dossier créé, incomplet (${missingEconomics(economics).join(", ")}). Ces valeurs restent inconnues tant que vous ne les avez pas fournies.` });
  await db.insert(schema.auditEvents).values({ id: newId("evt"), tenantId: u.tenantId, actor: "user:" + u.id, type: "property.created", entity: "Property", entityId: id, summary: `${u.name} ajoute le logement ${name}.` });
  // La clé PriceLabs est rattachée au logement : elle est vérifiée maintenant, le dossier est créé dans tous les cas.
  const key = txt(fd, "pricelabsKey");
  let plError = "";
  if (key) {
    try { const r = await connectPriceLabs(u.tenantId, id, key, "user:" + u.id); if (r.synced) await runDailyReview(u.tenantId, "MANUAL"); }
    catch (e) { plError = e instanceof SyncError ? e.message : "Erreur technique pendant la connexion à PriceLabs."; }
  }
  revalidatePath("/", "layout");
  redirect(`/logements/${id}?tab=pricelabs${plError ? "&erreur=" + encodeURIComponent(plError) : ""}`);
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
