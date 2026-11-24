/**
 * Garde-fous structurants (blueprint §6.4 et §11.3). Module pur, sans accès base : le service de revue lui fournit les actions
 * et les dossiers déjà connus du logement.
 *
 * - Verrou structurant : « une seule hypothèse structurante à la fois, par logement ». Tant qu'une modification du prix de base est
 *   en observation, aucune autre ne peut être proposée (règle de veto STRUCTURAL_LOCK).
 * - Plafond de variation sur 7 jours : les variations du prix de base approuvées ou exécutées sur les 7 derniers jours s'additionnent
 *   (valeur absolue : une hausse suivie d'une baisse n'annule pas le mouvement) et ne dépassent pas le plafond (MAX_VARIATION_7D).
 * - Groupe de repos : PB-02, PB-11 et PB-12 agissent sur le même levier dans des sens opposés ; l'approbation d'une action de l'un
 *   met les deux autres au repos (un refus ou une inaction ne bloque rien).
 */
import { addDays, todayISO, type ISODate } from "../dates";
import { cooldownGroupOf, playbookOf } from "./playbooks";

/** Plafond cumulé de variation du prix de base sur 7 jours glissants, en %. Même valeur que le plafond par action (policy.ts). */
export const MAX_BASE_VARIATION_7D_PCT = 15;
export const BASE_VARIATION_WINDOW_DAYS = 7;

/** Statuts d'une action de prix de base qui occupent le levier : approuvée, en cours d'écriture, écrite, vérifiée ou en mesure. */
export const STRUCTURAL_ACTIVE_STATUSES = ["APPROVED", "EXECUTING", "EXECUTED", "VERIFIED", "MEASURING"] as const;
/**
 * Statuts dont la variation compte dans le plafond de 7 jours : les précédents, plus les actions clôturées et celles dont le retour arrière a été fait.
 * Un retour arrière est lui-même un mouvement du prix de base : il ne libère pas le plafond. Les actions rejetées, annulées ou en échec n'ont rien changé.
 */
export const STRUCTURAL_COUNTED_STATUSES = [...STRUCTURAL_ACTIVE_STATUSES, "CLOSED", "ROLLED_BACK"] as const;

export type BaseChange = { at: ISODate; changePct: number };
export type StructuralHold = { reason: "ACTION_ACTIVE"; since: ISODate | null };

export type BaseActionRow = { type: string; status: string; approvedAt: Date | null; createdAt: Date; parameters: { changePct?: unknown } | null };

const isBase = (a: BaseActionRow) => a.type === "BASE_PRICE_CHANGE";
const pctOf = (a: BaseActionRow): number | null => (typeof a.parameters?.changePct === "number" && Number.isFinite(a.parameters.changePct) ? a.parameters.changePct : null);

/** Variations du prix de base des 7 derniers jours (aujourd'hui compris). Une variation inconnue compte pour le plafond entier : un doute ne libère pas le levier. */
export function recentBaseChanges(actions: BaseActionRow[], today: ISODate): BaseChange[] {
  const since = addDays(today, -(BASE_VARIATION_WINDOW_DAYS - 1));
  return actions.filter(isBase).filter((a) => (STRUCTURAL_COUNTED_STATUSES as readonly string[]).includes(a.status)).flatMap((a) => {
    const at = todayISO(a.approvedAt ?? a.createdAt);
    return at >= since ? [{ at, changePct: pctOf(a) ?? MAX_BASE_VARIATION_7D_PCT }] : [];
  });
}

/** Le prix de base est-il déjà en cours de test ? */
export function structuralHold(actions: BaseActionRow[]): StructuralHold | null {
  const active = actions.filter(isBase).filter((a) => (STRUCTURAL_ACTIVE_STATUSES as readonly string[]).includes(a.status));
  if (!active.length) return null;
  const first = active.map((a) => todayISO(a.approvedAt ?? a.createdAt)).sort()[0];
  return { reason: "ACTION_ACTIVE", since: first };
}

/** Variation cumulée sur 7 jours si l'on ajoute `changePct` : somme des valeurs absolues. */
export function cumulativeBaseVariation(recent: BaseChange[], changePct: number): number {
  return recent.reduce((s, c) => s + Math.abs(c.changePct), 0) + Math.abs(changePct);
}

export type GroupOpportunityRow = { playbook: string; status: string; createdAt: Date; decidedAt?: Date | null; decision?: string | null };

/**
 * Contrôle à l'approbation : le verdict d'audit d'un dossier date de sa détection, or une autre modification du prix de base a pu être approuvée depuis.
 * Renvoie le motif du refus, ou null si le levier est libre et le plafond respecté. Mêmes règles que STRUCTURAL_LOCK et MAX_VARIATION_7D.
 */
export function baseApprovalBlock(actions: BaseActionRow[], changePct: number, today: ISODate): string | null {
  const hold = structuralHold(actions);
  if (hold) return `Une modification du prix de base est déjà en cours${hold.since ? " depuis le " + hold.since.split("-").reverse().join("/") : ""} : attendez la fin de son observation ou son retour arrière avant d'en approuver une autre (une seule hypothèse structurante à la fois).`;
  const total = cumulativeBaseVariation(recentBaseChanges(actions, today), changePct);
  if (total > MAX_BASE_VARIATION_7D_PCT + 0.01) return `Cette modification porterait la variation du prix de base à ${total.toFixed(1).replace(".", ",")} % sur 7 jours, au-delà du plafond de ${MAX_BASE_VARIATION_7D_PCT} %.`;
  return null;
}

/**
 * Fin du repos de groupe pour un playbook, ou null s'il n'a pas de groupe ou si aucune approbation du groupe n'est en repos. Le repos de chaque
 * approbation dure la période de SON playbook ; seules les approbations des AUTRES playbooks du groupe comptent (le même playbook suit sa propre
 * clé de dédoublonnage et son propre repos).
 */
export function groupCooldownUntil(existing: GroupOpportunityRow[], playbook: string, now: Date): ISODate | null {
  const group = cooldownGroupOf(playbook);
  if (!group) return null;
  const today = todayISO(now);
  let until: ISODate | null = null;
  for (const o of existing) {
    // seule une approbation met le groupe au repos : un refus ou une inaction sur une hausse ne doit pas empêcher d'examiner une baisse
    if (o.status !== "DECIDED" || o.decision !== "APPROVED" || o.playbook === playbook || !(group as string[]).includes(o.playbook)) continue;
    const end = addDays(todayISO(o.decidedAt ?? o.createdAt), playbookOf(o.playbook)?.cooldownDays ?? 14);
    if (end > today && (!until || end > until)) until = end;
  }
  return until;
}
