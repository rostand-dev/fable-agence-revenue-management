"use server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { requireUser } from "@/lib/auth";
import { refused } from "@/lib/rights";
import { modelFromAnswers, type CostAnswers } from "@/lib/engine/costs";
import { missingEconomics } from "@/lib/engine/economics";
import { parseSeasons } from "@/lib/engine/seasons";
import { runDailyReview } from "@/lib/services/review";
import { syncPriceLabs } from "@/lib/services/pricelabs-sync";
import { advance } from "@/lib/onboarding";
import type { EconomicModel } from "@/lib/engine/types";
import { recordEconomicsVersion } from "@/lib/services/economics-versions";

const KEYS = ["airbnbPct", "bookingPct", "bookingFeePct", "cleaningFee", "cleaningCost", "linenMode", "linenCost", "nightMode", "energyYear", "waterYear", "consumablesStay", "nightsYear", "avgStay", "variableDirect", "hard", "rentCounted", "hardMode", "rent", "coop", "insurance", "subs", "taxes", "other", "nightsMonth", "goalMonth", "taxMode", "taxYear", "grossYear", "taxPct"];

/** Enregistre les réponses du parcours « Coûts et seuils ». `final` valide le modèle ; sinon c'est une sauvegarde d'étape. */
/** `question` : dans le parcours de création, la question où reprendre (0 à 7). */
export async function saveCostsAction(propertyId: string, raw: CostAnswers, final: boolean, question?: number): Promise<{ error?: string; done?: boolean }> {
  const u = await requireUser();
  const no = await refused(u, "property.manage", propertyId); if (no) return no;
  const [p] = await db.select().from(schema.properties).where(and(eq(schema.properties.id, propertyId), eq(schema.properties.tenantId, u.tenantId)));
  if (!p) return { error: "Logement introuvable." };
  if (p.isDemo) return { error: "Un logement de démonstration ne se modifie pas." };
  const a: CostAnswers = {};
  for (const k of KEYS) { const v = (raw as any)?.[k]; if (typeof v === "string") (a as any)[k] = v.slice(0, 24); }
  if (a.rentCounted !== "yes" && a.rentCounted !== "no") delete a.rentCounted;
  if (a.hardMode !== "set" && a.hardMode !== "none") delete a.hardMode;
  a.provisional = Array.isArray(raw?.provisional) ? raw.provisional.filter((x) => typeof x === "string").slice(0, 20) : [];
  const model = modelFromAnswers(a);
  const miss = missingEconomics(model);
  if (final && miss.length) return { error: `Il manque encore : ${miss.join(", ")}. Donnez au moins une estimation provisoire, ou enregistrez pour reprendre plus tard.` };
  const before = JSON.stringify({ ...(p.economics as any), seasons: undefined, answers: 0, provisional: 0 }), after = JSON.stringify({ ...model, answers: 0, provisional: 0 });
  const changed = before !== after; // (les saisons conservées ne comptent pas : elles ne sont pas saisies ici)
  // Pendant le parcours de création, le logement reste en onboarding : il n'est lancé qu'à l'étape « Vérification ».
  // Un logement déjà lancé n'est jamais rétrogradé : sans modèle complet, il n'y a simplement pas de revue (bannière « modèle incomplet »).
  const funnel = p.status === "ONBOARDING";
  // Le modèle et sa version s'écrivent ensemble. Pendant la création, une sauvegarde d'étape n'est pas versionnée : la première version naît à la validation.
  // Le modèle économique a sa propre numérotation (US-022) ; la version de la stratégie ne bouge plus quand il change.
  let versioned: number | null = null;
  let seasonError: string | null = null;
  await db.transaction(async (tx) => {
    // verrou sur le logement : le diff se calcule sur l'état réellement en base, pas sur une lecture faite avant l'attente d'une autre sauvegarde
    const [cur] = await tx.select({ economics: schema.properties.economics, economicsVersion: schema.properties.economicsVersion }).from(schema.properties).where(and(eq(schema.properties.id, p.id), eq(schema.properties.tenantId, u.tenantId))).for("update");
    // Les saisons (US-052) ne se saisissent pas ici : on conserve celles qui sont en base sous verrou (jamais une lecture périmée).
    // À la validation, elles doivent rester cohérentes avec le nouveau seuil de dérangement ; une sauvegarde d'étape n'est pas bloquée.
    const kept = (cur.economics as EconomicModel | null)?.seasons ?? [];
    if (kept.length) {
      if (final) { const chk = parseSeasons(kept, model); if (!chk.ok) { seasonError = `${chk.error} Ajustez d'abord les saisons du logement.`; return; } }
      model.seasons = kept;
    }
    await tx.update(schema.properties).set({
      economics: model,
      ...(funnel ? { onboarding: { ...advance(p.onboarding, "couts", final ? "next" : "stay"), costQ: final ? 0 : Math.min(7, Math.max(0, Math.trunc(question ?? 0))) } } : {}),
    }).where(eq(schema.properties.id, p.id));
    if (final || !funnel) {
      // pendant la création, la première version liste tout ce qui est renseigné ; sinon on compare à ce qui valait réellement
      const previous = funnel && cur.economicsVersion === 0 ? null : (cur.economics as EconomicModel);
      const r = await recordEconomicsVersion(tx, { tenantId: u.tenantId, propertyId: p.id, previous, next: model, createdBy: u.id });
      if (r) { versioned = r.version; await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.economics_versioned", entity: "Property", entityId: p.id, summary: `${u.name} enregistre la version ${r.version} du modèle économique de ${p.name}.`, payload: { version: r.version, changes: r.changes.map((c) => c.key) } }); }
    }
  });
  if (seasonError) return { error: seasonError };
  if (final) {
    const prov = model.provisional ?? [];
    await db.insert(schema.agentRuns).values({ id: newId("run"), tenantId: u.tenantId, agentId: "onboarding", operation: "costs", mode: "DETERMINISTIC", summary: `${p.name} : coûts et seuils validés, planchers calculés${prov.length ? `. ${prov.length} valeur${prov.length > 1 ? "s" : ""} provisoire${prov.length > 1 ? "s" : ""} à confirmer : ${prov.join(", ")}` : ""}.` });
    await recordAudit(db, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.costs_validated", entity: "Property", entityId: p.id, summary: `${u.name} valide les coûts et seuils de ${p.name}${prov.length ? ` (${prov.length} provisoire${prov.length > 1 ? "s" : ""})` : ""}.`, payload: { provisional: prov, changed, economicsVersion: versioned ?? p.economicsVersion } });
    // les commissions estimées et la taxe de séjour dépendent du modèle : PriceLabs est relu avant la revue
    if (funnel) { revalidatePath("/", "layout"); return { done: true }; }
    if (p.pricelabs?.listingId) { try { await syncPriceLabs(u.tenantId, p.id); } catch { /* consigné par la lecture */ } }
    try { await runDailyReview(u.tenantId, "MANUAL"); } catch (e) { console.error("[revue]", e); }
  }
  revalidatePath("/", "layout");
  return { done: final };
}
