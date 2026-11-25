/** Validation d'un changement de prix signalé (écran des modèles, PR 3). Écrit uniquement dans nos propres tables de prix. */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { invalidatePriceBook } from "./pricebook";
import { CATALOG } from "./catalog";

/** Nombre de modèles du catalogue dont un nouveau prix attend une décision (pastille du menu et carte du hub). */
export async function pendingPriceCount(): Promise<number> {
  const rows = await db.selectDistinct({ modelId: schema.llmPriceSnapshots.modelId }).from(schema.llmPriceSnapshots).where(eq(schema.llmPriceSnapshots.status, "PENDING"));
  const known = new Set(CATALOG.map((m) => m.modelId));
  return rows.filter((r) => known.has(r.modelId)).length;
}

/** Validation en un clic d'un changement de prix signalé (écran des modèles, PR 3). Renvoie false s'il n'y a rien à valider. Avec `snapshotId`, ne valide QUE le relevé que la personne a vu (un relevé plus récent ne passe pas par un clic sur l'ancien). */
export async function validatePendingPrice(modelId: string, validatedBy: string, now: Date = new Date(), snapshotId?: string): Promise<boolean> {
  const r = await db.update(schema.llmPriceSnapshots).set({ status: "VALIDATED", validatedAt: now, validatedBy, observedAt: now })
    .where(and(eq(schema.llmPriceSnapshots.modelId, modelId), eq(schema.llmPriceSnapshots.status, "PENDING"), ...(snapshotId ? [eq(schema.llmPriceSnapshots.id, snapshotId)] : []))).returning({ id: schema.llmPriceSnapshots.id });
  invalidatePriceBook();
  return r.length > 0;
}

/** Refus d'un changement de prix signalé : le prix validé reste en vigueur. */
export async function rejectPendingPrice(modelId: string, validatedBy: string, now: Date = new Date(), snapshotId?: string): Promise<boolean> {
  const r = await db.update(schema.llmPriceSnapshots).set({ status: "REJECTED", validatedAt: now, validatedBy })
    .where(and(eq(schema.llmPriceSnapshots.modelId, modelId), eq(schema.llmPriceSnapshots.status, "PENDING"), ...(snapshotId ? [eq(schema.llmPriceSnapshots.id, snapshotId)] : []))).returning({ id: schema.llmPriceSnapshots.id });
  return r.length > 0;
}
