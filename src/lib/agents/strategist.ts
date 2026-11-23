/** Stratèges (US-072) : Elias (tarif) et Hugo (distribution) donnent un avis sur leurs options via l'exécuteur d'agent (prompt versionné, budget, trace, repli). Contrôles et version par règles : `strategist-opinions.ts`. */
import type { DetectedOpportunity } from "../engine/types";
import { PROMPTS } from "./prompts";
import { FALLBACK_LABEL, runAgentTask, type AgentBudget, type AgentOutcome } from "./runner";
import { deterministicOpinion, factsHashOf, fromOpinionModel, opinionContext, opinionPrompt, opinionSchema, ownedOptions, type AgentOpinion, type OpinionOutput, type StrategistId } from "./strategist-opinions";

const PROMPT = { pricing: "pricing.option_opinion", distribution: "distribution.option_opinion" } as const;
export const opinionPromptVersion = (agent: StrategistId) => PROMPTS[PROMPT[agent]].version;

export async function opine(budget: AgentBudget, o: DetectedOpportunity, agent: StrategistId, opportunityId: string): Promise<{ opinion: AgentOpinion; outcome: AgentOutcome<OpinionOutput | null> }> {
  const outcome = await runAgentTask<OpinionOutput | null>({
    budget, agentId: agent, opportunityId, operation: "optionOpinion", prompt: PROMPT[agent], schema: opinionSchema(opinionContext(o, agent)),
    user: opinionPrompt(o, agent),
    summary: ({ mode, reason }) => `Avis sur ${ownedOptions(o, agent).length} option${ownedOptions(o, agent).length > 1 ? "s" : ""} du dossier « ${o.title} » ${mode === "LLM" ? "rédigé" : "composé par règles" + (reason && reason !== "NO_PROVIDER" ? " (repli : " + FALLBACK_LABEL[reason] + ")" : "")}.`,
    fallback: () => null,
  });
  const opinion = outcome.mode === "LLM" && outcome.data
    ? fromOpinionModel(o, agent, outcome.data, { model: outcome.run.model ?? undefined, promptVersion: outcome.run.promptVersion ?? undefined })
    : { ...deterministicOpinion(o, agent), factsHash: factsHashOf(o, agent, opinionPromptVersion(agent)), triedAt: new Date().toISOString() };
  return { opinion, outcome };
}
