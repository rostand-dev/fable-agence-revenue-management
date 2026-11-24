import { sql } from "drizzle-orm";
import { db } from "./index";

/**
 * Isolation par propriétaire côté base (US-011, blueprint §16.1 : « PostgreSQL Row Level Security complète les contrôles applicatifs »).
 *
 * `withTenant(tenantId, fn)` ouvre une transaction dans laquelle la base ne montre et n'accepte QUE les lignes de ce propriétaire :
 * même une requête oubliant son filtre `tenant_id` ne peut ni lire ni écrire chez un autre. Le rôle `nuitsignal_app` (migration 0011)
 * est endossé le temps de la transaction ; ses politiques comparent `tenant_id` à `app.tenant_id`.
 *
 * `TENANT_RLS=on` : l'isolation est exigée (échec fermé : sans le rôle, la requête échoue au lieu de s'exécuter sans protection).
 * Sinon (défaut), seul le filtre applicatif protège ; le statut est visible dans /api/health.
 * Limite : la RLS protège d'un filtre `tenant_id` oublié, pas d'une injection SQL arbitraire (la connexion peut réinitialiser son rôle).
 */
export const TENANT_TABLES = ["users", "properties", "reservations", "calendar_days", "market_days", "promotions", "opportunities", "revenue_actions", "agent_runs", "audit_events", "integrations", "feature_flags", "llm_credentials", "review_runs", "chat_messages", "owners", "listings", "economic_model_versions", "strategy_versions", "activation_validations", "reservation_nights", "reservation_changes", "superhote_webhooks", "webhook_deliveries", "source_snapshots", "action_transitions", "external_writes", "execution_alerts", "runbook_steps"] as const;
export const rlsRequired = () => (process.env.TENANT_RLS ?? "").trim().toLowerCase() === "on";

export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>, opts: { enforce?: boolean } = {}): Promise<T> {
  if (!tenantId) throw new Error("withTenant : propriétaire manquant");
  const enforce = opts.enforce ?? rlsRequired();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    if (enforce) await tx.execute(sql`set local role nuitsignal_app`); // échoue si le rôle manque : jamais d'exécution sans protection quand elle est exigée
    return fn(tx);
  });
}

export type IsolationStatus = "enforced" | "available" | "unavailable";
/** « enforced » : exigée et en place · « available » : en place mais non exigée (TENANT_RLS≠on) · « unavailable » : rôle ou politiques manquants */
export async function isolationStatus(): Promise<IsolationStatus> {
  const names = sql.raw(`array[${[...TENANT_TABLES, "tenants"].map((t) => `'${t}'`).join(",")}]`);
  const r = await db.execute(sql`select
    (select count(*) from pg_policies where policyname = 'tenant_isolation' and schemaname = current_schema() and tablename = any(${names})) as policies,
    (select count(*) from pg_class where relkind = 'r' and relrowsecurity and relname = any(${names})) as rls`);
  const row = r.rows[0] as { policies: string | number; rls: string | number };
  const expected = TENANT_TABLES.length + 1; // + tenants
  let ok = Number(row.policies) === expected && Number(row.rls) === expected;
  if (ok) {
    // sonde réelle : le rôle existe ET la connexion peut l'endosser (sinon les lectures protégées échoueraient en 500)
    try { await db.transaction(async (tx) => { await tx.execute(sql`set local role nuitsignal_app`); }); } catch { ok = false; }
  }
  return !ok ? "unavailable" : rlsRequired() ? "enforced" : "available";
}
