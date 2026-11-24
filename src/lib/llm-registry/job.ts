/** Job du registre LLM : lancé au démarrage du serveur, il ne synchronise que si la dernière synchronisation date de plus de LLM_SYNC_INTERVAL_HOURS. */
import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { syncIntervalHours } from "./config";
import { syncLlmRegistry } from "./sync";

let running = false;

/** Vrai si une synchronisation est due. Pur et testable. */
export function syncDue(lastStartedAt: Date | null, now: Date, intervalHours: number): boolean {
  if (intervalHours <= 0) return false;
  return !lastStartedAt || +now - +lastStartedAt >= intervalHours * 3600_000;
}

export async function runLlmSyncIfDue(now: Date = new Date()): Promise<boolean> {
  const hours = syncIntervalHours();
  if (hours <= 0 || running) return false;
  running = true;
  try {
    const [last] = await db.select({ at: schema.llmSyncRuns.startedAt }).from(schema.llmSyncRuns).orderBy(desc(schema.llmSyncRuns.startedAt)).limit(1);
    if (!syncDue(last?.at ?? null, now, hours)) return false;
    await syncLlmRegistry({ now });
    return true;
  } finally { running = false; }
}
