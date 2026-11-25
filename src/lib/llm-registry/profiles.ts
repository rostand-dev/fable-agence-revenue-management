/**
 * Profils de tâche du routeur LLM (plan « routeur LLM », section 5).
 * Pur : aucune base, aucun réseau. Un profil dit quel niveau de modèle une tâche exige, si le routeur peut monter de niveau
 * en cas d'échec, et quelle taille d'appel il faut compter pour estimer un coût avant l'appel.
 */
import { AGENT_BY_ID } from "../agents/registry";
import type { PromptId } from "../agents/prompts";
import type { ProviderKey, Tier } from "./catalog";

export type TaskId = PromptId | "chat";

export type TaskProfile = {
  task: TaskId;
  /** Niveau minimal accepté en mode automatique */
  minTier: Tier;
  /** Niveau maximal vers lequel le routeur peut monter */
  maxTier: Tier;
  /** Monter de niveau (jusqu'à 3 cibles de niveaux croissants) quand le modèle économique échoue */
  escalate: boolean;
  /** Jamais rétrogradé : seul un modèle du niveau minimal est candidat en automatique (Victor, l'auditeur) */
  neverDowngrade: boolean;
  /** Tâche dont l'aptitude (qualification) fait foi pour ce profil */
  qualifiedBy: PromptId;
  /** Fournisseurs autorisés pour cette tâche (le chat en flux n'existe que chez Anthropic) */
  providers: readonly ProviderKey[] | null;
  /** Taille d'appel typique, pour estimer le coût avant l'appel */
  estInputTokens: number;
  estOutputTokens: number;
};

const TEXT_TASK = { minTier: "eco", maxTier: "premium", escalate: true, neverDowngrade: false, providers: null, estInputTokens: 2500, estOutputTokens: 600 } as const;

export const PROFILES: Record<TaskId, TaskProfile> = {
  // Lina, Noor, Elias, Hugo : le moins cher qui convient, avec montée de niveau si besoin
  "direction.explain_action": { task: "direction.explain_action", qualifiedBy: "direction.explain_action", ...TEXT_TASK },
  "marche.market_analysis": { task: "marche.market_analysis", qualifiedBy: "marche.market_analysis", ...TEXT_TASK, estInputTokens: 3500 },
  "pricing.option_opinion": { task: "pricing.option_opinion", qualifiedBy: "pricing.option_opinion", ...TEXT_TASK },
  "distribution.option_opinion": { task: "distribution.option_opinion", qualifiedBy: "distribution.option_opinion", ...TEXT_TASK },
  // Victor, l'auditeur indépendant : toujours le niveau premium, jamais rétrogradé
  "audit.independent_review": { task: "audit.independent_review", minTier: "premium", maxTier: "premium", escalate: false, neverDowngrade: true, qualifiedBy: "audit.independent_review", providers: null, estInputTokens: 3000, estOutputTokens: 450 },
  // Conversation avec un agent : économique, sans montée de niveau, en flux (Anthropic seulement)
  chat: { task: "chat", minTier: "eco", maxTier: "eco", escalate: false, neverDowngrade: false, qualifiedBy: "direction.explain_action", providers: ["anthropic"], estInputTokens: 1800, estOutputTokens: 500 },
};

/** Tâche d'un agent quand elle n'est pas donnée explicitement (une seule tâche à base de modèle par agent). */
export const TASK_OF_AGENT: Record<string, TaskId> = {
  direction: "direction.explain_action", marche: "marche.market_analysis", pricing: "pricing.option_opinion", distribution: "distribution.option_opinion", audit: "audit.independent_review",
};

export function profileFor(agentId: string, task?: TaskId): TaskProfile {
  if (task) return PROFILES[task];
  const id = AGENT_BY_ID[agentId as keyof typeof AGENT_BY_ID] ? agentId : "direction";
  return PROFILES[TASK_OF_AGENT[id] ?? "direction.explain_action"];
}
