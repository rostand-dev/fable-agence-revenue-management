/**
 * Exigences d'approbation d'une option (blueprint §11.2, §5.6). Module pur, source unique pour le serveur (refus d'approuver sans commentaire) et pour
 * l'interface (champ obligatoire, motif affiché).
 *
 * Le compte est unique (l'application n'a pas encore de seconde personne qui valide) : « validation du propriétaire » se traduit par un
 * commentaire d'approbation obligatoire, consigné au journal. Le serveur le refuse s'il manque, quel que soit l'écran ou l'API utilisée.
 */
import { CANDIDATE_SPECS } from "./candidates";
import { playbookOf, threshold } from "./playbooks";
import type { Candidate } from "./types";

export const MIN_COMMENT_LENGTH = 8;

export type ApprovalRequirement = { commentRequired: boolean; reasons: string[] };

export function approvalRequirement(c: Pick<Candidate, "type" | "risk" | "audit"> & { parameters?: Candidate["parameters"] }, playbook?: string | null): ApprovalRequirement {
  const reasons: string[] = [];
  if (c.audit.verdict === "NEEDS_HUMAN") reasons.push("l'auditeur demande une validation humaine");
  if (c.risk === "HIGH") reasons.push("action à risque élevé");
  if (c.risk === "CRITICAL") reasons.push("action à risque critique");
  // approbation du propriétaire ou du mandat (§11.2) : seulement pour une action qui s'exécute, jamais pour l'inaction ni une simple vérification
  const pb = playbook ? playbookOf(playbook) : null;
  if (playbook && !pb) console.warn(`[approval] playbook inconnu du catalogue : ${playbook} (aucune exigence propriétaire appliquée)`);
  if (pb?.approver === "REVENUE_MANAGER_AND_OWNER" && CANDIDATE_SPECS[c.type]?.executable) reasons.push(`le playbook ${pb.code} demande la validation du propriétaire ou du mandat`);
  // remise de durée de séjour au-delà du seuil (mensuelle > 15 %, §11.2) : approbation renforcée, quel que soit le playbook
  const p = c.parameters as Record<string, unknown> | undefined;
  const cap = threshold("PB-09", "commentOverPct");
  if (c.type === "CHANNEL_PROMO" && p?.kind === "LOS" && typeof p.discountPct === "number" && p.discountPct > cap) reasons.push(`remise de durée de séjour de ${String(p.discountPct).replace(".", ",")} %, au-delà de ${cap} %`);
  return { commentRequired: reasons.length > 0, reasons };
}
