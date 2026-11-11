import { ensureMigrated } from "@/db";
import { runDueReviews } from "@/lib/services/review";

/** Démarrage du serveur : migrations, puis planification interne de la revue quotidienne. */
export async function start() {
  if (!process.env.DATABASE_URL) return;
  try { await ensureMigrated(); } catch (e) { console.error("[démarrage] migrations en échec", e); return; }
  const tick = () => runDueReviews().catch((e) => console.error("[revue planifiée]", e));
  setTimeout(tick, 20_000);
  setInterval(tick, 15 * 60_000);
}
