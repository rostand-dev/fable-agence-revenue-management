import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { properties } from "@/db/schema";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { missingEconomics } from "@/lib/engine/economics";
import { parseSeasons, seasonalFloorGrid } from "@/lib/engine/seasons";
import type { EconomicModel, Season } from "@/lib/engine/types";
import { FLOOR_LOS } from "@/lib/activation-gates";
import { recordEconomicsVersion } from "@/lib/services/economics-versions";
import { PortfolioError } from "@/lib/services/portfolio";

type Actor = { id: string; name: string; tenantId: string };

async function loadProperty(tenantId: string, propertyId: string) {
  const [p] = await db.select({ id: properties.id, name: properties.name, isDemo: properties.isDemo, economics: properties.economics, economicsVersion: properties.economicsVersion }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  return p;
}

/** Saisons et grille des planchers d'un logement. Modèle incomplet : la grille est vide et `missing` dit ce qui manque (jamais de plancher inventé). */
export async function getFloors(tenantId: string, propertyId: string) {
  const p = await loadProperty(tenantId, propertyId);
  const model = p.economics as EconomicModel;
  const missing = missingEconomics(model);
  return {
    propertyId: p.id, economicsVersion: p.economicsVersion,
    seasons: model.seasons ?? [],
    complete: missing.length === 0, missing,
    grid: missing.length ? [] : seasonalFloorGrid(model, [...FLOOR_LOS]),
  };
}

/**
 * Remplace les saisons d'un logement. Crée une version du modèle économique (US-022) et invalide la validation des planchers
 * (l'empreinte change) ; rien n'est écrit si la liste est identique. Le verrou sur le logement évite deux écritures concurrentes.
 */
export async function saveSeasons(u: Actor, propertyId: string, raw: unknown): Promise<{ seasons: Season[]; version: number | null }> {
  const p = await loadProperty(u.tenantId, propertyId);
  if (p.isDemo) throw new PortfolioError("INVALID", "Un logement de démonstration ne se modifie pas.");
  return db.transaction(async (tx) => {
    const [cur] = await tx.select({ economics: properties.economics }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, u.tenantId))).for("update");
    if (!cur) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
    const previous = cur.economics as EconomicModel;
    const miss = missingEconomics(previous);
    if (miss.length) throw new PortfolioError("INVALID", `Renseignez d'abord les coûts et seuils : il manque ${miss.join(", ")}.`);
    const parsed = parseSeasons(raw, previous);
    if (!parsed.ok) throw new PortfolioError("INVALID", parsed.error);
    const next: EconomicModel = { ...previous };
    if (parsed.seasons.length) next.seasons = parsed.seasons; else delete next.seasons;
    const r = await recordEconomicsVersion(tx, { tenantId: u.tenantId, propertyId, previous, next, createdBy: u.id });
    // même sans nouvelle version (ordre seul), la liste saisie est celle qui reste
    if (!r) { if (JSON.stringify(previous.seasons ?? []) !== JSON.stringify(parsed.seasons)) await tx.update(properties).set({ economics: next }).where(and(eq(properties.id, propertyId), eq(properties.tenantId, u.tenantId))); return { seasons: parsed.seasons, version: null }; }
    await tx.update(properties).set({ economics: next }).where(and(eq(properties.id, propertyId), eq(properties.tenantId, u.tenantId)));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.economics_versioned", entity: "Property", entityId: propertyId, summary: `${u.name} modifie les saisons du plancher de ${p.name} (version ${r.version}).`, payload: { version: r.version, changes: r.changes.map((c) => c.key) } });
    return { seasons: parsed.seasons, version: r.version };
  });
}
