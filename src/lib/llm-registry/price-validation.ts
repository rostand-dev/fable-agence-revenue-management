/** Validation d'un changement de prix signalé (écran des modèles, PR 3). Écrit uniquement dans nos propres tables de prix. */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { invalidatePriceBook } from "./pricebook";

/** Validation en un clic d'un changement de prix signalé (écran des modèles, PR 3). Renvoie false s'il n'y a rien à valider. */
export async function validatePendingPrice(modelId: string, validatedBy: string, now: Date = new Date()): Promise<boolean> {
  const r = await db.update(schema.llmPriceSnapshots).set({ status: "VALIDATED", validatedAt: now, validatedBy, observedAt: now })
    .where(and(eq(schema.llmPriceSnapshots.modelId, modelId), eq(schema.llmPriceSnapshots.status, "PENDING"))).returning({ id: schema.llmPriceSnapshots.id });
  invalidatePriceBook();
  return r.length > 0;
}

/** Refus d'un changement de prix signalé : le prix validé reste en vigueur. */
export async function rejectPendingPrice(modelId: string, validatedBy: string, now: Date = new Date()): Promise<boolean> {
  const r = await db.update(schema.llmPriceSnapshots).set({ status: "REJECTED", validatedAt: now, validatedBy })
    .where(and(eq(schema.llmPriceSnapshots.modelId, modelId), eq(schema.llmPriceSnapshots.status, "PENDING"))).returning({ id: schema.llmPriceSnapshots.id });
  return r.length > 0;
}
