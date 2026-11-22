/**
 * Cycle d'ouverture des dossiers (blueprint §9.4, US-061) : déduplication, regroupement et période de repos.
 * Module pur, sans accès base : le service de revue lui fournit l'état des dossiers existants et applique sa réponse.
 *
 * - Déduplication : un même signal (logement, playbook, clé de dédoublonnage) ne produit qu'un dossier, d'une revue à l'autre
 *   comme au sein d'une même revue (on garde le plus prioritaire).
 * - Période de repos : après une décision humaine, le même signal ne rouvre pas de dossier pendant `cooldownDays` du playbook,
 *   comptés depuis la décision. Un dossier différé reste fermé jusqu'à son échéance.
 * - Regroupement : les dossiers d'un même logement dont les nuits se touchent partagent une clé, pour être lus ensemble.
 */
import { addDays, todayISO, type ISODate } from "../dates";
import { playbookOf } from "./playbooks";

export type OpportunityStatus = "OPEN" | "DEFERRED" | "DECIDED" | "EXPIRED";
export type ExistingOpportunity = { status: string; createdAt: Date; decidedAt?: Date | null; deferUntil?: ISODate | null };

export type OpeningDecision =
  | { action: "CREATE" }
  | { action: "REFRESH" }
  | { action: "SKIP"; reason: "COOLDOWN" | "DEFERRED"; until: ISODate | null };

/** Jours de repos d'un playbook ; un code inconnu retombe sur 14 jours (jamais 0 : un doute ne rouvre pas un dossier tranché). */
export function cooldownDaysOf(playbook: string): number {
  return playbookOf(playbook)?.cooldownDays ?? 14;
}

/** Que faire d'un signal présent, au vu du dossier existant le plus récent pour la même clé ? */
export function openingDecision(prev: ExistingOpportunity | undefined, playbook: string, now: Date): OpeningDecision {
  if (!prev || prev.status === "EXPIRED") return { action: "CREATE" };
  if (prev.status === "OPEN") return { action: "REFRESH" };
  if (prev.status === "DEFERRED") return { action: "SKIP", reason: "DEFERRED", until: prev.deferUntil ?? null };
  if (prev.status === "DECIDED") {
    // le repos se compte en jours civils (Europe/Paris, comme toute l'application) : il se termine au matin de l'échéance affichée
    const until = endOfCooldown(prev.decidedAt ?? prev.createdAt, playbook);
    if (todayISO(now) < until) return { action: "SKIP", reason: "COOLDOWN", until };
  }
  return { action: "CREATE" };
}

/** Garde un seul dossier par clé : le plus prioritaire, puis le plus tôt. L'ordre d'origine est conservé. */
export function dedupeOpportunities<T extends { dedupe?: string | null; playbook: string; stayFrom: ISODate }>(opps: T[], score: (o: T) => number): T[] {
  const best = new Map<string, T>();
  for (const o of opps) {
    const key = `${o.playbook}|${o.dedupe ?? o.stayFrom}`;
    const cur = best.get(key);
    if (!cur || score(o) > score(cur) || (score(o) === score(cur) && o.stayFrom < cur.stayFrom)) best.set(key, o);
  }
  const keep = new Set(best.values());
  return opps.filter((o) => keep.has(o));
}

/**
 * Regroupe les dossiers dont les nuits se chevauchent ou se touchent (la fin d'un séjour est exclusive : [du, au[).
 * Renvoie, pour chaque dossier, la clé de son groupe : `groupe|première nuit du groupe`. Un dossier isolé a une clé à lui seul.
 */
export function groupKeys(opps: { stayFrom: ISODate; stayTo: ISODate }[], propertyId: string): string[] {
  const order = opps.map((_, i) => i).sort((a, b) => opps[a].stayFrom.localeCompare(opps[b].stayFrom) || opps[a].stayTo.localeCompare(opps[b].stayTo));
  const keys: string[] = new Array(opps.length);
  let groupStart: ISODate | null = null, groupEnd: ISODate | null = null;
  for (const i of order) {
    const o = opps[i];
    if (groupStart === null || groupEnd === null || o.stayFrom > groupEnd) { groupStart = o.stayFrom; groupEnd = o.stayTo; }
    else if (o.stayTo > groupEnd) groupEnd = o.stayTo;
    keys[i] = `${propertyId}|${groupStart}`;
  }
  return keys;
}

/** Libellé d'une période de repos pour l'écran : « jusqu'au 26/11/2026 ». */
export function cooldownLabel(until: ISODate): string {
  return `jusqu'au ${until.split("-").reverse().join("/")}`;
}

export const endOfCooldown = (decidedAt: Date, playbook: string): ISODate => addDays(todayISO(decidedAt), cooldownDaysOf(playbook));
