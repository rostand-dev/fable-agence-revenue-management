"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { requireUser } from "@/lib/auth";
import { modelFromAnswers, type CostAnswers } from "@/lib/engine/costs";
import { missingEconomics } from "@/lib/engine/economics";
import { runDailyReview } from "@/lib/services/review";
import { syncPriceLabs } from "@/lib/services/pricelabs-sync";
import { advance } from "@/lib/onboarding";

const KEYS = ["airbnbPct", "bookingPct", "bookingFeePct", "cleaningFee", "cleaningCost", "linenMode", "linenCost", "nightMode", "energyYear", "waterYear", "consumablesStay", "nightsYear", "avgStay", "variableDirect", "hard", "rent", "coop", "insurance", "subs", "taxes", "other", "nightsMonth", "goalMonth", "taxMode", "taxYear", "grossYear", "taxPct"];

/** Enregistre les réponses du parcours « Coûts et seuils ». `final` valide le modèle ; sinon c'est une sauvegarde d'étape. */
/** `question` : dans le parcours de création, la question où reprendre (0 à 7). */
export async function saveCostsAction(propertyId: string, raw: CostAnswers, final: boolean, question?: number): Promise<{ error?: string; done?: boolean }> {
  const u = await requireUser();
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, propertyId), eq(schema.properties.tenantId, u.tenantId)));
  if (!p) return { error: "Logement introuvable." };
  if (p.isDemo) return { error: "Un logement de démonstration ne se modifie pas." };
  const a: CostAnswers = {};
  for (const k of KEYS) { const v = (raw as any)?.[k]; if (typeof v === "string") (a as any)[k] = v.slice(0, 24); }
  a.provisional = Array.isArray(raw?.provisional) ? raw.provisional.filter((x) => typeof x === "string").slice(0, 20) : [];
  const model = modelFromAnswers(a);
  const miss = missingEconomics(model);
  if (final && miss.length) return { error: `Il manque encore : ${miss.join(", ")}. Donnez au moins une estimation provisoire, ou enregistrez pour reprendre plus tard.` };
  const before = JSON.stringify({ ...(p.economics as any), answers: 0, provisional: 0 }), after = JSON.stringify({ ...model, answers: 0, provisional: 0 });
  const changed = before !== after;
  // Pendant le parcours de création, le logement reste en onboarding : il n'est lancé qu'à l'étape « Vérification ».
  // Un logement déjà lancé n'est jamais rétrogradé : sans modèle complet, il n'y a simplement pas de revue (bannière « modèle incomplet »).
  const funnel = p.status === "ONBOARDING";
  await db.update(schema.properties).set({
    economics: model, status: p.status,
    ...(funnel ? { onboarding: { ...advance(p.onboarding, "couts", final ? "next" : "stay"), costQ: final ? 0 : Math.min(7, Math.max(0, Math.trunc(question ?? 0))) } } : {}),
    strategyVersion: changed && p.status !== "ONBOARDING" ? p.strategyVersion + 1 : p.strategyVersion,
  }).where(eq(schema.properties.id, p.id));
  if (final) {
    const prov = model.provisional ?? [];
    await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: u.tenantId, agentId: "onboarding", operation: "costs", mode: "DETERMINISTIC", summary: `${p.name} : coûts et seuils validés, planchers calculés${prov.length ? `. ${prov.length} valeur${prov.length > 1 ? "s" : ""} provisoire${prov.length > 1 ? "s" : ""} à confirmer : ${prov.join(", ")}` : ""}.` });
    await recordAudit(db, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.costs_validated", entity: "Property", entityId: p.id, summary: `${u.name} valide les coûts et seuils de ${p.name}${prov.length ? ` (${prov.length} provisoire${prov.length > 1 ? "s" : ""})` : ""}.`, payload: { provisional: prov, changed, strategyVersion: changed && p.status !== "ONBOARDING" ? p.strategyVersion + 1 : p.strategyVersion } });
    // les commissions estimées et la taxe de séjour dépendent du modèle : PriceLabs est relu avant la revue
    if (funnel) { revalidatePath("/", "layout"); return { done: true }; }
    if (p.pricelabs?.listingId) { try { await syncPriceLabs(u.tenantId, p.id); } catch { /* consigné par la lecture */ } }
    try { await runDailyReview(u.tenantId, "MANUAL"); } catch (e) { console.error("[revue]", e); }
  }
  revalidatePath("/", "layout");
  return { done: final };
}
