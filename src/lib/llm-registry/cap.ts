/**
 * Plafond mensuel de dépense LLM par propriétaire (en euros). Vide par défaut = aucun plafond.
 * Stocké dans tenants.settings.llmMonthlyCapEur ; l'application du plafond (alerte à 80 %, arrêt à 100 %) vient avec le routeur (PR 2).
 */
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { usdEurRate } from "./config";

export const MAX_MONTHLY_CAP_EUR = 100000;

/** Valide la saisie : vide ou null = pas de plafond ; sinon un montant en euros strictement positif, au plus 2 décimales, au plus 100 000. */
export function parseMonthlyCapEur(input: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null };
  const raw = typeof input === "string" ? input.trim().replace(",", ".") : input;
  if (raw === "") return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "Saisissez un montant en euros supérieur à 0, ou laissez vide pour ne fixer aucun plafond." };
  if (n > MAX_MONTHLY_CAP_EUR) return { ok: false, error: `Le plafond ne peut pas dépasser ${MAX_MONTHLY_CAP_EUR.toLocaleString("fr-FR")} € par mois.` };
  if (Math.round(n * 100) / 100 !== n) return { ok: false, error: "Le plafond s'exprime en euros, avec 2 décimales au plus." };
  return { ok: true, value: n };
}

/** Plafond lu dans les réglages (valeur absente ou invalide = aucun plafond). */
export function capFromSettings(settings: Record<string, any> | null | undefined): number | null {
  const r = parseMonthlyCapEur(settings?.llmMonthlyCapEur);
  return r.ok ? r.value : null;
}

export const usdToEur = (usd: number, rate: number = usdEurRate()): number => Math.round(usd * rate * 1e6) / 1e6;

export async function getMonthlyCapEur(tenantId: string): Promise<number | null> {
  const [t] = await db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  return capFromSettings(t?.settings);
}

/** Enregistre (ou efface, avec null) le plafond. N'écrase aucun autre réglage de l'espace. */
export async function setMonthlyCapEur(tenantId: string, value: number | null): Promise<void> {
  if (value === null) await db.update(schema.tenants).set({ settings: sql`${schema.tenants.settings} - 'llmMonthlyCapEur'` }).where(eq(schema.tenants.id, tenantId));
  else await db.update(schema.tenants).set({ settings: sql`jsonb_set(${schema.tenants.settings}, '{llmMonthlyCapEur}', to_jsonb(${value}::numeric), true)` }).where(eq(schema.tenants.id, tenantId));
}
