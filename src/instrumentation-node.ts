import { ensureMigrated } from "@/db";
import { runDue } from "@/lib/services/scheduler";
import { ensureDemoAccount } from "@/lib/services/demo-account";
import { installLogMasking } from "@/lib/privacy/pii";
import { runLlmSyncIfDue, runObservedSuspension } from "@/lib/llm-registry/job";

/** Démarrage du serveur : migrations, puis planification interne — lectures et revues de chaque logement à son rythme. */
export async function start() {
  // US-034 : avant tout autre journal, pour qu'aucune donnée personnelle (e-mail, téléphone, IBAN, carte, secret) n'atteigne les logs du serveur
  installLogMasking();
  if (!process.env.DATABASE_URL) return;
  try { await ensureMigrated(); } catch (e) { console.error("[démarrage] migrations en échec", e); return; }
  // Preview uniquement (DEMO_ACCOUNT_ENABLED + domaine autorisé) ; un échec ne doit jamais empêcher le démarrage.
  try { await ensureDemoAccount(); } catch (e) { console.error("[compte démo] échec", e); }
  const tick = () => runDue().catch((e) => console.error("[planificateur]", e));
  setTimeout(tick, 20_000);
  setInterval(tick, 15 * 60_000);
  // Registre LLM (prix et disponibilité des modèles) : une passe au démarrage puis un contrôle horaire ; ne synchronise que si la dernière passe est assez ancienne (LLM_SYNC_INTERVAL_HOURS, 0 = désactivé).
  const llmSync = () => runLlmSyncIfDue().then(() => runObservedSuspension()).catch((e) => console.error("[registre LLM]", e));
  setTimeout(llmSync, 45_000);
  setInterval(llmSync, 60 * 60_000);
}
