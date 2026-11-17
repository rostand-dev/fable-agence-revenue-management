import { ensureMigrated } from "@/db";
import { runDue } from "@/lib/services/scheduler";

/** Démarrage du serveur : migrations, puis planification interne — lectures et revues de chaque logement à son rythme. */
export async function start() {
  if (!process.env.DATABASE_URL) return;
  try { await ensureMigrated(); } catch (e) { console.error("[démarrage] migrations en échec", e); return; }
  const tick = () => runDue().catch((e) => console.error("[planificateur]", e));
  setTimeout(tick, 20_000);
  setInterval(tick, 15 * 60_000);
}
