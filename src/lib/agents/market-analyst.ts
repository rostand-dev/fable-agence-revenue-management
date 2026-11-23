/** Market Analyst (US-071) : appel du modèle via l'exécuteur d'agent (prompt versionné, budget, trace, repli). Les contrôles et la version par règles sont dans `market-analysis.ts`. */
import type { DetectedOpportunity } from "../engine/types";
import { PROMPTS } from "./prompts";
import { analysisContext, analysisPrompt, analysisSchema, deterministicAnalysis, evidenceHashOf, fromModel, type AnalysisOutput, type MarketAnalysis } from "./market-analysis";
import { FALLBACK_LABEL, retryable, runAgentTask, type AgentBudget, type AgentOutcome } from "./runner";

export async function analyzeMarket(budget: AgentBudget, o: DetectedOpportunity, opportunityId: string): Promise<{ analysis: MarketAnalysis; outcome: AgentOutcome<AnalysisOutput | null> }> {
  const outcome = await runAgentTask<AnalysisOutput | null>({
    budget, agentId: "marche", opportunityId, operation: "marketFindings", prompt: "marche.market_analysis", schema: analysisSchema(analysisContext(o)),
    user: analysisPrompt(o),
    summary: ({ mode, reason }) => `Constats de marché du dossier « ${o.title} » ${mode === "LLM" ? "rédigés avec preuves numérotées" : "composés par règles" + (reason && reason !== "NO_PROVIDER" ? " (repli : " + FALLBACK_LABEL[reason] + ")" : "")}.`,
    fallback: () => null,
  });
  const analysis = outcome.mode === "LLM" && outcome.data ? fromModel(o, outcome.data, { model: outcome.run.model ?? undefined, promptVersion: outcome.run.promptVersion ?? undefined }) : { ...deterministicAnalysis(o), evidenceHash: evidenceHashOf(o, PROMPTS["marche.market_analysis"].version), ...(retryable(outcome.run.fallbackReason) ? { triedAt: new Date().toISOString() } : {}) };
  return { analysis, outcome };
}
