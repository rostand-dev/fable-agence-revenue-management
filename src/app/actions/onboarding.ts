"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { missingEconomics } from "@/lib/engine/economics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import { advance, isStep, launchBlockers, stepLabel, type OnboardingState, type StepKey } from "@/lib/onboarding";
import { parseMarkupList } from "@/lib/pricing/published";
import { selectListing, SyncError, syncPriceLabs } from "@/lib/services/pricelabs-sync";
import { runDailyReview } from "@/lib/services/review";
import { selectRental } from "@/lib/services/superhote-sync";

/**
 * Actions du parcours de création d'un logement. Chaque passage d'une étape à l'autre enregistre la saisie
 * et l'étape où reprendre ; « Enregistrer et quitter » enregistre sans exiger de champ.
 */
const txt = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
/** Champ vide = inconnu (null), jamais zéro. */
const num = (fd: FormData, k: string): number | null => { const v = txt(fd, k).replace(",", "."); if (v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const EMPTY: EconomicModel = { channels: {}, cleaningFeeChargedCents: null, cleaningCostCents: null, linenCostCents: null, nightlyVariableCostCents: null, hardContributionPerNightCents: null, strategyContributionPerNightCents: null, targetContributionPerNightCents: null, origin: "DECLARED", touristTaxPct: null };
const creation = (id: string, step: StepKey) => `/logements/${id}/creation?etape=${step}`;
const QUIT = "/logements?enregistre=1";

async function load(tenantId: string, id: string) {
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, id), eq(schema.properties.tenantId, tenantId)));
  if (!p) throw new SyncError("Logement introuvable.");
  if (p.isDemo) throw new SyncError("Un logement de démonstration ne se modifie pas.");
  if (p.status !== "ONBOARDING") throw new SyncError("Ce logement est déjà lancé : modifiez-le depuis sa fiche.");
  return p;
}
async function setState(id: string, state: OnboardingState) {
  await db.update(schema.properties).set({ onboarding: state }).where(eq(schema.properties.id, id));
}
/** Exécute l'action ; une erreur métier revient près du formulaire, une redirection passe telle quelle. */
async function guard(fn: (u: Awaited<ReturnType<typeof requireUser>>) => Promise<string>): Promise<FormState> {
  const u = await requireUser();
  let to: string;
  try { to = await fn(u); } catch (e) {
    if (e instanceof SyncError) return { error: e.message };
    console.error("[creation]", e instanceof Error ? e.message : e);
    return { error: "Erreur technique. Votre saisie précédente est conservée." };
  }
  revalidatePath("/", "layout");
  redirect(to);
}

function readIdentity(fd: FormData) {
  return { name: txt(fd, "name"), city: txt(fd, "city"), kind: txt(fd, "kind"), bedrooms: num(fd, "bedrooms"), capacity: num(fd, "capacity"), positioning: txt(fd, "positioning") || undefined, objective: txt(fd, "objective") || undefined };
}
const identityError = (v: { name: string; city: string; kind: string }) =>
  v.name.length < 2 || v.city.length < 2 || !v.kind ? "Le nom, la ville et le type du logement sont nécessaires pour continuer. Pour vous arrêter ici, utilisez « Enregistrer et quitter »." : null;

/** Étape 1 : création du dossier (sans identifiant) ou mise à jour. intent = next | quit. */
export async function saveLogementAction(_: FormState, fd: FormData): Promise<FormState> {
  return guard(async (u) => {
    const quit = txt(fd, "intent") === "quit";
    const v = readIdentity(fd), id0 = txt(fd, "propertyId");
    if (!quit) { const err = identityError(v); if (err) throw new SyncError(err); }
    const how = quit ? "stay" : "next";
    if (!id0) {
      if (quit && !v.name && !v.city && !v.kind) return "/logements";
      const id = newId("prop"), name = v.name || "Logement sans nom";
      const strategy: Strategy = { basePriceCents: null, minPriceCents: null, maxPriceCents: null, minStay: null, objective: v.objective, positioning: v.positioning, maxDiscountStackPct: 20, maxPriceChangePct: 5 };
      await db.insert(schema.properties).values({ id, tenantId: u.tenantId, name, city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity, status: "ONBOARDING", isDemo: false, profile: { positioning: v.positioning ?? null }, economics: EMPTY, strategy, channelMarkups: [], onboarding: advance(null, "logement", how) });
      await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: u.tenantId, agentId: "onboarding", operation: "onboard", mode: "DETERMINISTIC", summary: `${name} : création du logement commencée.` });
      await recordAudit(db, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.created", entity: "Property", entityId: id, summary: `${u.name} commence la création du logement ${name}.`, payload: { name, city: v.city, kind: v.kind } });
      return quit ? QUIT : creation(id, "superhote");
    }
    const p = await load(u.tenantId, id0);
    const old = p.strategy as Strategy;
    const next = advance(p.onboarding, "logement", how);
    await db.update(schema.properties).set({
      name: v.name || p.name || "Logement sans nom", city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity,
      strategy: { ...old, objective: v.objective, positioning: v.positioning }, profile: { ...p.profile, positioning: v.positioning ?? null },
      onboarding: next,
    }).where(eq(schema.properties.id, p.id));
    return quit ? QUIT : creation(p.id, next.step as StepKey);
  });
}

/** Étape 4 : séjour minimum et majorations SuperHote par canal. */
export async function saveReglesAction(_: FormState, fd: FormData): Promise<FormState> {
  return guard(async (u) => {
    const p = await load(u.tenantId, txt(fd, "propertyId"));
    const quit = txt(fd, "intent") === "quit";
    const mk = parseMarkupList(fd.getAll("markupLabel").map(String), fd.getAll("markupPct").map(String));
    if (!mk.ok) throw new SyncError(mk.error);
    const next = advance(p.onboarding, "regles", quit ? "stay" : "next");
    const minStay = num(fd, "minStay"), oldStrategy = p.strategy as Strategy;
    await db.update(schema.properties).set({ strategy: { ...oldStrategy, minStay }, channelMarkups: mk.markups, onboarding: next }).where(eq(schema.properties.id, p.id));
    // les règles de vente pilotent le prix publié estimé : tout changement est tracé, un simple passage d'étape ne l'est pas
    if (oldStrategy.minStay !== minStay || JSON.stringify(p.channelMarkups) !== JSON.stringify(mk.markups)) {
      await recordAudit(db, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.rules_saved", entity: "Property", entityId: p.id, summary: `${u.name} enregistre les règles de vente de ${p.name} (séjour minimum, majorations par canal).`, payload: { minStay: { from: oldStrategy.minStay ?? null, to: minStay }, markups: { from: p.channelMarkups, to: mk.markups } } });
    }
    return quit ? QUIT : creation(p.id, next.step as StepKey);
  });
}

/** Étapes sans saisie (connexions, vérification) : quitter, reporter ou continuer. */
export async function stepAction(_: FormState, fd: FormData): Promise<FormState> {
  return guard(async (u) => {
    const p = await load(u.tenantId, txt(fd, "propertyId"));
    const step = txt(fd, "step"), intent = txt(fd, "intent");
    if (!isStep(step)) throw new SyncError("Étape inconnue.");
    if (intent === "quit") { await setState(p.id, advance(p.onboarding, step, "stay")); return QUIT; }
    if (intent === "skip") {
      if (step !== "superhote" && step !== "pricelabs") throw new SyncError("Cette étape ne peut pas être reportée.");
      const next = advance(p.onboarding, step, "skip");
      await setState(p.id, next);
      return creation(p.id, next.step as StepKey);
    }
    if (step === "superhote" && !p.superhote?.rentalId) throw new SyncError("Confirmez d'abord le logement SuperHote, ou choisissez « Je le ferai plus tard ».");
    if (step === "pricelabs" && !p.pricelabs?.listingId) throw new SyncError("Confirmez d'abord l'annonce PriceLabs, ou choisissez « Je le ferai plus tard ».");
    const next = advance(p.onboarding, step, "next");
    await setState(p.id, next);
    return creation(p.id, next.step as StepKey);
  });
}

/** Confirmation du logement SuperHote, puis étape suivante. La première lecture des réservations se fait ici. */
export async function funnelSelectRentalAction(_: FormState, fd: FormData): Promise<FormState> {
  return guard(async (u) => {
    const p = await load(u.tenantId, txt(fd, "propertyId"));
    await selectRental(u.tenantId, p.id, txt(fd, "rentalId"), "user:" + u.id);
    const next = advance(p.onboarding, "superhote", "next");
    await setState(p.id, next);
    return creation(p.id, next.step as StepKey);
  });
}
/** Confirmation de l'annonce PriceLabs (première lecture de la grille), puis étape suivante. */
export async function funnelSelectListingAction(_: FormState, fd: FormData): Promise<FormState> {
  return guard(async (u) => {
    const p = await load(u.tenantId, txt(fd, "propertyId"));
    await selectListing(u.tenantId, p.id, txt(fd, "listingId"), "user:" + u.id);
    const next = advance(p.onboarding, "pricelabs", "next");
    await setState(p.id, next);
    return creation(p.id, next.step as StepKey);
  });
}

/** Étape 6 : lancement de l'observation. Bloqué tant que l'identité, PriceLabs ou les coûts manquent. */
export async function launchAction(_: FormState, fd: FormData): Promise<FormState> {
  return guard(async (u) => {
    const p = await load(u.tenantId, txt(fd, "propertyId"));
    if (txt(fd, "intent") === "quit") { await setState(p.id, advance(p.onboarding, "verification", "stay")); return QUIT; }
    const missing = missingEconomics(p.economics as EconomicModel).length;
    const blockers = launchBlockers({ identityOk: p.name.length >= 2 && p.city.length >= 2 && !!p.kind, superhoteLinked: !!p.superhote?.rentalId, pricelabsLinked: !!p.pricelabs?.listingId, economicsMissing: missing, onboarding: p.onboarding });
    if (blockers.length) throw new SyncError(`Avant de lancer l'observation, complétez : ${blockers.map(stepLabel).join(", ")}.`);
    const now = new Date();
    await db.update(schema.properties).set({ status: "SHADOW", onboarding: { ...advance(p.onboarding, "verification", "stay", now), completedAt: now.toISOString() } }).where(eq(schema.properties.id, p.id));
    await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: u.tenantId, agentId: "onboarding", operation: "onboard", mode: "DETERMINISTIC", summary: `${p.name} : dossier complet, observation lancée${p.superhote?.rentalId ? "" : " (SuperHote à connecter : réservations lues via PriceLabs)"}.` });
    await recordAudit(db, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.launched", entity: "Property", entityId: p.id, summary: `${u.name} lance l'observation de ${p.name}.`, payload: { superhoteLinked: !!p.superhote?.rentalId, pricelabsLinked: !!p.pricelabs?.listingId } });
    // les commissions estimées et la taxe de séjour dépendent du modèle : PriceLabs est relu avant la première revue
    try { await syncPriceLabs(u.tenantId, p.id); } catch { /* consigné par la lecture */ }
    try { await runDailyReview(u.tenantId, "MANUAL", { propertyIds: [p.id] }); } catch (e) { console.error("[revue]", e); }
    return `/logements/${p.id}?lance=1`;
  });
}
