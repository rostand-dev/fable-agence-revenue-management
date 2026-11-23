/** Auditeur indépendant (US-073) : appel du modèle via l'exécuteur d'agent (prompt versionné, budget, trace, repli). Contrôles et application : `independent-review.ts`. */
import type { DetectedOpportunity } from "../engine/types";
import { PROMPTS } from "./prompts";
import { FALLBACK_LABEL, retryable, runAgentTask, type AgentBudget, type AgentOutcome } from "./runner";
import { fromReviewModel, noReview, reviewContext, reviewPrompt, reviewSchema, type IndependentReview, type ReviewOutput } from "./independent-review";

export const reviewPromptVersion = () => PROMPTS["audit.independent_review"].version;

export async function secondReading(budget: AgentBudget, o: DetectedOpportunity, opportunityId: string): Promise<{ review: IndependentReview; outcome: AgentOutcome<ReviewOutput | null> }> {
  const outcome = await runAgentTask<ReviewOutput | null>({
    budget, agentId: "audit", opportunityId, operation: "independentReview", prompt: "audit.independent_review", schema: reviewSchema(reviewContext(o)),
    user: reviewPrompt(o),
    summary: ({ mode, reason }) => `Seconde lecture de l'option retenue du dossier « ${o.title} » ${mode === "LLM" ? "effectuée" : "non effectuée" + (reason && reason !== "NO_PROVIDER" ? " (repli : " + FALLBACK_LABEL[reason] + ")" : "")}.`,
    fallback: () => null,
  });
  const review = outcome.mode === "LLM" && outcome.data
    ? fromReviewModel(o, outcome.data, { model: outcome.run.model ?? undefined, promptVersion: outcome.run.promptVersion ?? undefined })
    : { ...noReview(o, reviewPromptVersion()), ...(retryable(outcome.run.fallbackReason) ? { triedAt: new Date().toISOString() } : {}) };
  return { review, outcome };
}
