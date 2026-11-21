import { and, desc, eq } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { floorFingerprint, floorsState, parseReconciliation, reconciliationState, FLOOR_LOS, type FloorsState, type ReconciliationState } from "@/lib/activation-gates";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { floorGrid } from "@/lib/engine/economics";
import type { EconomicModel } from "@/lib/engine/types";
import { PortfolioError, type PortfolioActor } from "./portfolio";

const { properties, activationValidations: av } = schema;
type Ex = Pick<typeof db, "select">;
type Kind = "FLOORS" | "RECONCILIATION";

async function latest(ex: Ex, tenantId: string, propertyId: string, kind: Kind) {
  const [r] = await ex.select().from(av).where(and(eq(av.tenantId, tenantId), eq(av.propertyId, propertyId), eq(av.kind, kind))).orderBy(desc(av.createdAt), desc(av.id)).limit(1);
  return r ? { ...r, createdAt: r.createdAt.toISOString() } : null;
}

/** Ce que la checklist doit savoir des validations humaines d'un logement (dernière validation de chaque type). */
export async function loadGateFacts(ex: Ex, tenantId: string, propertyId: string, economics: EconomicModel) {
  const fp = floorFingerprint(economics);
  const [f, r] = await Promise.all([latest(ex, tenantId, propertyId, "FLOORS"), latest(ex, tenantId, propertyId, "RECONCILIATION")]);
  return {
    floors: floorsState(f, fp),
    reconciliation: reconciliationState(r ? { payload: r.payload, validatedByName: r.validatedByName, createdAt: r.createdAt } : null),
    fingerprint: fp,
    reconciliationDetail: r ? { source: String(r.payload.source ?? ""), note: (r.payload.note as string | null) ?? null } : null,
  };
}

export type ValidationsView = {
  name: string; status: string; isDemo: boolean;
  floors: FloorsState; fingerprint: string | null;
  grid: { channel: string; nights: number; hardCents: number; strategyCents: number }[];
  reconciliation: ReconciliationState; reconciliationDetail: { source: string; note: string | null } | null;
};

export async function getValidations(tenantId: string, propertyId: string): Promise<ValidationsView> {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  const econ = p.economics as EconomicModel;
  const g = await loadGateFacts(db, tenantId, propertyId, econ);
  let grid: ValidationsView["grid"] = [];
  if (g.fingerprint) grid = floorGrid(econ, [...FLOOR_LOS]);
  return { name: p.name, status: p.status, isDemo: p.isDemo, floors: g.floors, fingerprint: g.fingerprint, grid, reconciliation: g.reconciliation, reconciliationDetail: g.reconciliationDetail };
}

/** Les validations se font pendant l'observation d'un vrai logement, jamais sur une démonstration ni pendant la création. */
function assertValidatable(p: typeof properties.$inferSelect) {
  if (p.isDemo) throw new PortfolioError("INVALID", "Un logement de démonstration ne se valide pas.");
  if (p.status !== "SHADOW") throw new PortfolioError("INVALID", p.status === "ACTIVE" ? "Ce logement est déjà actif." : "Les validations se font une fois l'observation lancée.");
}

/**
 * Validation des planchers par une personne. Elle porte sur la grille que la personne a vue (empreinte) : si les coûts ont changé
 * entre-temps, elle est refusée et la personne revoit la nouvelle grille. Elle devient « périmée » dès que la grille change.
 */
export async function validateFloors(u: PortfolioActor, propertyId: string, seenFingerprint: unknown, note: unknown) {
  const n = String(note ?? "").trim();
  if (n.length > 300) throw new PortfolioError("INVALID", "Commentaire : 300 caractères au maximum.");
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, u.tenantId))).for("update");
    if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
    assertValidatable(p);
    const econ = p.economics as EconomicModel;
    const fp = floorFingerprint(econ);
    if (!fp) throw new PortfolioError("INVALID", "Les planchers ne peuvent pas être validés : le modèle économique est incomplet.");
    if (typeof seenFingerprint !== "string" || seenFingerprint !== fp) throw new PortfolioError("CONFLICT", "Les planchers ont changé depuis l'affichage : rechargez la page et relisez la grille avant de valider.");
    const grid = floorGrid(econ, [...FLOOR_LOS]);
    await tx.insert(av).values({ id: newId("val"), tenantId: u.tenantId, propertyId: p.id, kind: "FLOORS", fingerprint: fp, payload: { grid }, validatedBy: u.id, validatedByName: u.name, note: n || null, createdAt: new Date() }); // horodatage pris sous verrou : « la dernière » est bien la dernière
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.floors_validated", entity: "Property", entityId: p.id, summary: `${u.name} valide les planchers de ${p.name} (${grid.length} combinaisons canal × durée).`, payload: { fingerprint: fp, economicsVersion: p.economicsVersion, cells: grid.length } });
  });
}

/**
 * Attestation manuelle du rapprochement d'un échantillon de réservations (taille, écart maximal constaté, source).
 * Elle est enregistrée même si elle ne suffit pas (échantillon trop petit, écart > 1 %) : la checklist dit alors pourquoi.
 */
export async function recordReconciliation(u: PortfolioActor, propertyId: string, raw: Record<string, unknown>) {
  const r = parseReconciliation(raw);
  if (!r.ok) throw new PortfolioError("INVALID", r.error);
  await db.transaction(async (tx) => {
    const [p] = await tx.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, u.tenantId))).for("update");
    if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
    assertValidatable(p);
    await tx.insert(av).values({ id: newId("val"), tenantId: u.tenantId, propertyId: p.id, kind: "RECONCILIATION", fingerprint: null, payload: r.value, validatedBy: u.id, validatedByName: u.name, note: r.value.note, createdAt: new Date() });
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.reconciliation_recorded", entity: "Property", entityId: p.id, summary: `${u.name} atteste le rapprochement de ${r.value.sampleSize} réservations de ${p.name} (écart maximal ${r.value.maxGapPct} %).`, payload: { sampleSize: r.value.sampleSize, maxGapPct: r.value.maxGapPct, source: r.value.source } });
  });
}
