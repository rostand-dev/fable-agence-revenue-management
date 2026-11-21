import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { missingEconomics } from "@/lib/engine/economics";
import type { EconomicModel, Strategy } from "@/lib/engine/types";
import { evaluateMapping } from "@/lib/mapping";
import { calendarStateOf, evaluateQuality, type QualityReport } from "@/lib/quality";
import { identityComplete } from "@/lib/onboarding";
import { loadMappingFacts } from "./mapping";
import { PortfolioError, type PortfolioActor } from "./portfolio";

const { properties } = schema;
type Ex = Pick<typeof db, "select">;

export type QualityView = QualityReport & { name: string; status: string; isDemo: boolean };

/** Lit ce dont la checklist a besoin pour un logement de cet espace seulement (verrou de ligne si `lock`). */
async function evaluate(ex: Ex, tenantId: string, propertyId: string, lock = false) {
  const { p, facts } = await loadMappingFacts(ex, tenantId, propertyId, lock);
  const strategy = (p.strategy ?? {}) as Strategy;
  const report = evaluateQuality({
    identityOk: identityComplete(p),
    pricelabsLinked: !!p.pricelabs?.listingId,
    calendar: calendarStateOf(p.pricelabs?.lastSync as never),
    economicsMissing: missingEconomics(p.economics as EconomicModel).length,
    mappingStatus: evaluateMapping(facts).status,
    prices: { basePriceCents: strategy.basePriceCents ?? null, minPriceCents: strategy.minPriceCents ?? null, maxPriceCents: strategy.maxPriceCents ?? null },
    superhoteLinked: !!p.superhote?.rentalId,
    provisionalCount: ((p.economics as EconomicModel)?.provisional ?? []).length,
  });
  return { p, report };
}

export async function getQuality(tenantId: string, propertyId: string): Promise<QualityView> {
  const { p, report } = await evaluate(db, tenantId, propertyId);
  return { ...report, name: p.name, status: p.status, isDemo: p.isDemo };
}

/**
 * Observation → Actif. La checklist est recalculée dans la transaction, sur la ligne verrouillée : on active ce qui est
 * vérifié à cet instant, pas ce qui était affiché. Le détail de la checklist est conservé dans le journal.
 */
export async function activateProperty(u: PortfolioActor, propertyId: string) {
  await db.transaction(async (tx) => {
    const { p, report } = await evaluate(tx, u.tenantId, propertyId, true);
    if (p.isDemo) throw new PortfolioError("INVALID", "Un logement de démonstration ne s'active pas.");
    if (p.status === "ACTIVE") throw new PortfolioError("INVALID", "Ce logement est déjà actif.");
    if (p.status !== "SHADOW") throw new PortfolioError("INVALID", "Seul un logement en observation peut être activé : lancez d'abord l'observation depuis le parcours de création.");
    if (!report.canActivate) {
      const todo = report.items.filter((i) => report.blockers.includes(i.key)).map((i) => `${i.label} (${i.detail.replace(/\.$/, "")})`);
      throw new PortfolioError("INVALID", `Activation refusée. À corriger : ${todo.join(" ; ")}.`);
    }
    await tx.update(properties).set({ status: "ACTIVE" }).where(and(eq(properties.id, p.id), eq(properties.tenantId, u.tenantId)));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.activated", entity: "Property", entityId: p.id, summary: `${u.name} active ${p.name} : la checklist de qualité est satisfaite.`, payload: { warnings: report.warnings, checks: report.items.map((i) => ({ key: i.key, ok: i.ok, severity: i.severity })) } });
  });
}
