/** Lecture d'une situation, partagée par la carte complète (`SitCard`) et la carte compacte du mode poche : mêmes libellés, mêmes conditions. */
import { approvalRequirement } from "./engine/approval";
import type { Candidate } from "./engine/types";

export function needsComment(c: Candidate, playbook?: string | null) { return approvalRequirement(c, playbook).commentRequired; }

export type SituationRole = "veto" | "tech" | "attention" | "neutre" | "sain";

export function situationRole(o: { veto: boolean; playbook: string }, c: Candidate): { role: SituationRole; label: string } {
  if (o.veto) return { role: "veto", label: "Veto économique" };
  if (o.playbook === "PB-10") return { role: "tech", label: "Donnée à vérifier" };
  if (o.playbook === "PB-13") return { role: "attention", label: "Réglage PriceLabs à corriger" };
  if (c.type === "NO_ACTION") return { role: "neutre", label: "Inaction recommandée" };
  if (c.audit.verdict === "NEEDS_HUMAN") return { role: "attention", label: "Validation renforcée" };
  return { role: "sain", label: "Option conforme" };
}

export const approveLabel = (c: Candidate) => (c.type === "NO_ACTION" ? "Retenir l'inaction" : "Approuver");

/**
 * Mode poche : décider depuis la carte seulement quand rien n'oblige à lire le dossier
 * (option conforme, sans veto ni commentaire requis) et que la personne a le droit de décision.
 * Le serveur reste le seul juge : cette règle ne fait que retirer un bouton.
 */
export function quickApprovable(o: { status: string; veto: boolean; playbook: string }, c: Candidate, canDecide: boolean): boolean {
  return o.status === "OPEN" && canDecide && !o.veto && c.audit.verdict === "APPROVE" && !needsComment(c, o.playbook);
}
