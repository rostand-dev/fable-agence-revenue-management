/** Machine à états d'une action (blueprint §6.6). Aucune mise à jour libre du statut. */
export const ACTION_STATES = [
  "DRAFT", "SIMULATED", "AUDITED", "PENDING_APPROVAL", "APPROVED", "EXECUTING", "EXECUTED", "VERIFIED", "MEASURING", "CLOSED",
  "REJECTED", "FAILED", "ROLLED_BACK", "CANCELLED", "EXPIRED",
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

const T: Record<ActionState, ActionState[]> = {
  DRAFT: ["SIMULATED", "CANCELLED"],
  SIMULATED: ["AUDITED", "CANCELLED"],
  AUDITED: ["PENDING_APPROVAL", "REJECTED", "CANCELLED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED"],
  APPROVED: ["EXECUTING", "CANCELLED", "EXPIRED"],
  EXECUTING: ["EXECUTED", "FAILED"],
  EXECUTED: ["VERIFIED", "FAILED", "ROLLED_BACK"],
  VERIFIED: ["MEASURING", "ROLLED_BACK"],
  MEASURING: ["CLOSED", "ROLLED_BACK"],
  CLOSED: [], REJECTED: [], FAILED: ["ROLLED_BACK"], ROLLED_BACK: [], CANCELLED: [], EXPIRED: [],
};
export function canTransition(from: ActionState, to: ActionState): boolean { return T[from]?.includes(to) ?? false; }
export function assertTransition(from: ActionState, to: ActionState): void {
  if (!canTransition(from, to)) throw new Error(`Transition interdite : ${from} → ${to}`);
}
export const STATE_LABEL: Record<ActionState, string> = {
  DRAFT: "Brouillon", SIMULATED: "Simulée", AUDITED: "Auditée", PENDING_APPROVAL: "En attente d'approbation", APPROVED: "Approuvée",
  EXECUTING: "En cours d'exécution", EXECUTED: "Exécutée", VERIFIED: "Vérifiée", MEASURING: "En mesure", CLOSED: "Clôturée",
  REJECTED: "Rejetée", FAILED: "En échec", ROLLED_BACK: "Annulée (rollback)", CANCELLED: "Abandonnée", EXPIRED: "Expirée",
};
/** Les huit étapes du cycle Observer → Mesurer, et l'état à partir duquel chacune est faite. */
export const CYCLE = ["Observer", "Diagnostiquer", "Proposer", "Simuler", "Valider", "Exécuter", "Vérifier", "Mesurer"] as const;
export function cycleProgress(status: ActionState | null): number {
  if (!status) return 4; // observer, diagnostiquer, proposer, simuler faits ; valider en cours
  const map: Partial<Record<ActionState, number>> = { PENDING_APPROVAL: 4, APPROVED: 5, EXECUTING: 5, EXECUTED: 6, VERIFIED: 7, MEASURING: 7, CLOSED: 8 };
  return map[status] ?? 4;
}
