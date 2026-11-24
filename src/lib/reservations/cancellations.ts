import { todayISO, type ISODate } from "../dates";
import type { Snap } from "./nights";

export type ChangeRow = { externalId: string; kind: string; before: unknown; after: unknown; createdAt: Date };
export type CancelledReservation = { externalId: string; before: Snap; at: ISODate };

/**
 * Réservations annulées d'après l'historique `reservation_changes`, dans l'ordre chronologique des lignes reçues.
 * Une réservation est « annulée » selon sa dernière transition : annulée (statut final CANCELLED, venant d'un autre statut), puis remise en vigueur ou non.
 * Un évènement ultérieur qui la laisse annulée (modification de montant, relecture) ne change rien : l'annulation d'origine reste comptée.
 * Le jour d'annulation est le jour civil de Paris de l'enregistrement du changement.
 */
export function cancelledFromChanges(changes: ChangeRow[]): CancelledReservation[] {
  const by = new Map<string, CancelledReservation>();
  for (const c of changes) {
    const wasCancelled = (c.before as Snap | null)?.status === "CANCELLED";
    const nowCancelled = (c.after as { status?: string } | null)?.status === "CANCELLED" || c.kind === "CANCELLED";
    if (nowCancelled && !wasCancelled && c.before) by.set(c.externalId, { externalId: c.externalId, before: c.before as Snap, at: todayISO(c.createdAt) });
    else if (!nowCancelled) by.delete(c.externalId);
  }
  return [...by.values()];
}
