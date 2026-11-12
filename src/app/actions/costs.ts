"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { requireUser } from "@/lib/auth";
import { modelFromAnswers, type CostAnswers } from "@/lib/engine/costs";
import { missingEconomics } from "@/lib/engine/economics";
import { runDailyReview } from "@/lib/services/review";
import { syncPriceLabs } from "@/lib/services/pricelabs-sync";

const KEYS = ["airbnbPct", "bookingPct", "bookingFeePct", "cleaningFee", "cleaningCost", "linenMode", "linenCost", "nightMode", "energyYear", "waterYear", "consumablesStay", "nightsYear", "avgStay", "variableDirect", "hard", "rent", "coop", "insurance", "subs", "taxes", "other", "nightsMonth", "goalMonth", "taxMode", "taxYear", "grossYear", "taxPct"];

/** Enregistre les réponses du parcours « Coûts et seuils ». `final` valide le modèle ; sinon c'est une sauvegarde d'étape. */
export async function saveCostsAction(propertyId: string, raw: CostAnswers, final: boolean): Promise<{ error?: string; done?: boolean }> {
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
  const identity = p.name.length >= 2 && p.city.length >= 2 && !!p.kind;
  const complete = miss.length === 0;
  const before = JSON.stringify({ ...(p.economics as any), answers: 0, provisional: 0 }), after = JSON.stringify({ ...model, answers: 0, provisional: 0 });
  const changed = before !== after;
  await db.update(schema.properties).set({
    economics: model, status: !complete || !identity ? "ONBOARDING" : p.status === "ONBOARDING" ? "SHADOW" : p.status,
    strategyVersion: changed && p.status !== "ONBOARDING" ? p.strategyVersion + 1 : p.strategyVersion,
  }).where(eq(schema.properties.id, p.id));
  if (final) {
    const prov = model.provisional ?? [];
    await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: u.tenantId, agentId: "onboarding", operation: "costs", mode: "DETERMINISTIC", summary: `${p.name} : coûts et seuils validés, planchers calculés${prov.length ? `. ${prov.length} valeur${prov.length > 1 ? "s" : ""} provisoire${prov.length > 1 ? "s" : ""} à confirmer : ${prov.join(", ")}` : ""}.` });
    await db.insert(schema.auditEvents).values({ id: newId("evt"), tenantId: u.tenantId, actor: "user:" + u.id, type: "property.costs_validated", entity: "Property", entityId: p.id, summary: `${u.name} valide les coûts et seuils de ${p.name}${prov.length ? ` (${prov.length} provisoire${prov.length > 1 ? "s" : ""})` : ""}.` });
    // les commissions estimées et la taxe de séjour dépendent du modèle : PriceLabs est relu avant la revue
    if (p.pricelabs?.listingId) { try { await syncPriceLabs(u.tenantId, p.id); } catch { /* consigné par la lecture */ } }
    try { await runDailyReview(u.tenantId, "MANUAL"); } catch (e) { console.error("[revue]", e); }
  }
  revalidatePath("/", "layout");
  return { done: final };
}
