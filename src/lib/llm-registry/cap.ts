/**
 * Écriture du plafond mensuel de dépense LLM (réglage du propriétaire). La lecture, la dépense du mois et l'état (alerte à 80 %, atteint à 100 %) sont dans `cap-state.ts`,
 * module en lecture seule que les agents et le routeur importent ; celui-ci écrit en base et n'est jamais importé par un agent.
 */
import { sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";

export * from "./cap-state";

/** Enregistre (ou efface, avec null) le plafond. N'écrase aucun autre réglage de l'espace. */
export async function setMonthlyCapEur(tenantId: string, value: number | null): Promise<void> {
  if (value === null) await db.update(schema.tenants).set({ settings: sql`${schema.tenants.settings} - 'llmMonthlyCapEur'` }).where(eq(schema.tenants.id, tenantId));
  else await db.update(schema.tenants).set({ settings: sql`jsonb_set(${schema.tenants.settings}, '{llmMonthlyCapEur}', to_jsonb(${value}::numeric), true)` }).where(eq(schema.tenants.id, tenantId));
}

