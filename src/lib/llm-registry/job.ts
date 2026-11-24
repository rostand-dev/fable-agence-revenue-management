/**
 * Job du registre LLM : lancé au démarrage du serveur, il ne synchronise que si la dernière passe est assez ancienne.
 * Après un échec (ou une passe interrompue), nouvel essai au bout d'une heure, pas après 24 h.
 * Le droit de lancer une passe est pris sous verrou consultatif PostgreSQL (insertion conditionnelle) : deux instances du serveur ne la lancent jamais en double.
 */
import { sql } from "drizzle-orm";
import { db, newId } from "@/db";
import { syncIntervalHours } from "./config";
import { syncLlmRegistry } from "./sync";

export const RETRY_AFTER_FAILURE_HOURS = 1;

/** Vrai si une synchronisation est due. Pur et testable. `last` : la passe la plus récente (ok = terminée sans erreur). */
export function syncDue(last: { startedAt: Date; ok: boolean } | null, now: Date, intervalHours: number): boolean {
  if (intervalHours <= 0) return false;
  if (!last) return true;
  const wait = last.ok ? intervalHours : Math.min(intervalHours, RETRY_AFTER_FAILURE_HOURS);
  return +now - +last.startedAt >= wait * 3600_000;
}

/** Prend le droit de lancer une passe : insère la ligne de passe seulement si aucune passe récente (réussie : intervalle ; échouée ou en cours : 1 h) n'existe. Renvoie son identifiant, ou null. */
export async function claimSyncRun(now: Date, intervalHours: number): Promise<string | null> {
  const id = newId("llms"), retry = Math.min(intervalHours, RETRY_AFTER_FAILURE_HOURS);
  // verrou consultatif le temps de la transaction : sans lui, deux instances qui interrogent en même temps verraient toutes deux « aucune passe récente »
  return db.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('llm_sync_claim'))`);
  const r: any = await tx.execute(sql`INSERT INTO llm_sync_runs (id, started_at) SELECT ${id}, ${now.toISOString()}::timestamptz
    WHERE NOT EXISTS (SELECT 1 FROM llm_sync_runs WHERE (ok AND started_at > ${now.toISOString()}::timestamptz - make_interval(hours => ${intervalHours}))
                                                    OR (NOT ok AND started_at > ${now.toISOString()}::timestamptz - make_interval(hours => ${retry})))
    RETURNING id`);
  return (r.rows ?? r).length > 0 ? id : null;
  });
}

export async function runLlmSyncIfDue(now: Date = new Date()): Promise<boolean> {
  const hours = syncIntervalHours();
  if (hours <= 0) return false;
  const id = await claimSyncRun(now, hours);
  if (!id) return false;
  await syncLlmRegistry({ now }, id);
  return true;
}
