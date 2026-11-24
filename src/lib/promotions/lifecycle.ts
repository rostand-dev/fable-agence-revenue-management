/**
 * Cycle de vie d'une promotion après sa confirmation (US-104, blueprint §10.3, §11.3 et Annexe B étape 7).
 * Module pur : seconde relecture, période de repos, expiration. Les services l'appliquent ; rien ici n'écrit chez un canal.
 */
import { addDays, todayISO, type ISODate } from "../dates";

/** Après la fin manuelle d'une promotion, pas de promotion du même type sur le même canal pendant ce nombre de jours (blueprint §11.3). */
export const COOLDOWN_DAYS = 7;
/** Une action manuelle confirmée peut être vérifiée par la même personne seulement après ce délai. */
export const REREAD_MIN_HOURS = 24;
/** Motif posé par le balayage ; il distingue une expiration naturelle d'une fin décidée (seule la seconde ouvre une période de repos). */
export const EXPIRY_REASON = "Expirée : séjours terminés";

/** Motif posé quand le retour arrière d'une action défait une promotion qu'elle avait créée : ce n'est pas une fin décidée, aucun repos. */
export const ROLLBACK_REASON = "Retour arrière de l'action";

const fr = (d: ISODate) => d.split("-").reverse().join("/");
const dayOf = (d: Date): ISODate => todayISO(d); // jour civil Europe/Paris, comme partout ailleurs

export type VerifyDecision = { ok: true; by: "OTHER_PERSON" | "LATER_REREAD" } | { ok: false; error: string; earliest: Date | null };

/**
 * Qui peut vérifier une action manuelle confirmée : une autre personne, ou la même après 24 h.
 * `declaredBy` absent (anciennes actions) : on ne peut pas affirmer que c'est une autre personne, seul le délai compte.
 */
export function canVerifyManual(i: { executedAt: Date | null; declaredBy: string | null; actorId: string; now: Date }): VerifyDecision {
  if (i.declaredBy && i.declaredBy !== i.actorId) return { ok: true, by: "OTHER_PERSON" };
  const earliest = i.executedAt ? new Date(+i.executedAt + REREAD_MIN_HOURS * 3_600_000) : null;
  if (earliest && +i.now >= +earliest) return { ok: true, by: "LATER_REREAD" };
  const when = earliest ? earliest.toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" }) : null;
  return { ok: false, earliest, error: `Une action confirmée à la main doit être relue par une autre personne, ou par la même personne au moins ${REREAD_MIN_HOURS} h après${when ? ` (à partir du ${when})` : ""} : une relecture immédiate ne prouve rien.` };
}

export type EndedRow = { channel: string; kind: string; listingId: string | null; status: string; endedAt: Date | null; endReason: string | null; label: string };
export type Cooldown = { until: ISODate; label: string };

/**
 * Période de repos applicable à une promotion `candidate` : la plus tardive des fins manuelles du même canal et du même type (même annonce, ou l'une ne vise pas d'annonce précise), plus 7 jours.
 * Renvoie null s'il n'y a pas de repos en cours à la date `today`.
 */
export function cooldownFor(rows: EndedRow[], c: { channel: string; kind: string; listingId?: string | null }, today: ISODate): Cooldown | null {
  let best: Cooldown | null = null;
  for (const r of rows) {
    if (r.status !== "ENDED" || !r.endedAt || r.endReason === EXPIRY_REASON || r.endReason === ROLLBACK_REASON) continue;
    if (r.channel !== c.channel || r.kind.toUpperCase() !== c.kind.toUpperCase()) continue;
    if (r.listingId && c.listingId && r.listingId !== c.listingId) continue;
    const until = addDays(dayOf(r.endedAt), COOLDOWN_DAYS);
    if (until > today && (!best || until > best.until)) best = { until, label: r.label };
  }
  return best;
}

export const cooldownText = (cd: Cooldown, channelLabel: string) =>
  `« ${cd.label} » vient d'être terminée sur ${channelLabel} : une promotion du même type attend la fin de la période de repos de ${COOLDOWN_DAYS} jours (jusqu'au ${fr(cd.until)}) pour laisser lire l'effet de l'arrêt avant d'en remettre une.`;

/** Promotions à terminer par le balayage : actives ou planifiées dont les séjours sont passés (fin exclue). Une promotion permanente n'expire jamais. */
export function isExpired(p: { status: string; stayTo: ISODate | null }, today: ISODate): boolean {
  return (p.status === "ACTIVE" || p.status === "PLANNED") && !!p.stayTo && p.stayTo <= today;
}
