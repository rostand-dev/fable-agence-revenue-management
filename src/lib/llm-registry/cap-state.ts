/**
 * Plafond mensuel de dépense LLM par propriétaire (en euros). Vide par défaut = aucun plafond.
 * Stocké dans tenants.settings.llmMonthlyCapEur. Dépense du mois lue dans les traces (agent_runs.cost_usd) ; alerte à 80 %, plus aucun appel de modèle à 100 % jusqu'à la fin du mois.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { usdEurRate } from "./config";

export const MAX_MONTHLY_CAP_EUR = 100000;

/** Valide la saisie : vide ou null = pas de plafond ; sinon un montant en euros strictement positif, au plus 2 décimales, au plus 100 000. */
export function parseMonthlyCapEur(input: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, value: null };
  const raw = typeof input === "string" ? input.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".") : input;
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

export const CAP_ALERT_RATIO = 0.8;
/** Premier instant du mois (UTC) : le plafond se remet à zéro à ce moment. */
export const monthStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Dépense LLM du mois en USD (coûts connus ; un appel sans prix connu compte pour 0, jamais une valeur inventée ; un test de modèle en cours ou interrompu compte pour son estimation maximale). */
export async function monthlySpendUsd(tenantId: string, now: Date = new Date()): Promise<number> {
  const [r] = await db.select({ n: sql<string>`coalesce(sum(coalesce(${schema.agentRuns.costUsd}, case when ${schema.agentRuns.operation} = 'bench' then ${schema.agentRuns.costEstimatedUsd} end)), 0)` }).from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.tenantId, tenantId), gte(schema.agentRuns.createdAt, monthStart(now))));
  return Number(r?.n ?? 0);
}

export type CapState = { capEur: number | null; spentUsd: number; spentEur: number; rate: number; ratio: number | null; level: "none" | "ok" | "alert" | "reached"; remainingUsd: number | null };
/** État du plafond : pur, testable. 80 % = alerte ; 100 % = atteint (plus aucun appel de modèle jusqu'à la fin du mois). */
export function capState(capEur: number | null, spentUsd: number, rate: number = usdEurRate()): CapState {
  const spentEur = usdToEur(spentUsd, rate);
  if (capEur === null) return { capEur, spentUsd, spentEur, rate, ratio: null, level: "none", remainingUsd: null };
  const ratio = spentEur / capEur;
  return { capEur, spentUsd, spentEur, rate, ratio, level: ratio >= 1 ? "reached" : ratio >= CAP_ALERT_RATIO ? "alert" : "ok", remainingUsd: Math.max(0, capEur / rate - spentUsd) };
}

/** État à AFFICHER (hub, Budget) : la dépense du mois est lue même sans plafond, pour ne jamais annoncer 0 € à tort. */
export async function getSpendState(tenantId: string, now: Date = new Date()): Promise<CapState> {
  const [capEur, spent] = await Promise.all([getMonthlyCapEur(tenantId), monthlySpendUsd(tenantId, now)]);
  return capState(capEur, spent);
}

/** État pour les contrôles et les bandeaux : sans plafond, la dépense n'est pas lue (elle vaut 0 ici). */
export async function getCapState(tenantId: string, now: Date = new Date()): Promise<CapState> {
  const capEur = await getMonthlyCapEur(tenantId);
  return capState(capEur, capEur === null ? 0 : await monthlySpendUsd(tenantId, now));
}
