import { z } from "zod";
import { FALLBACK_LABEL, runAgentTask, type AgentBudget, type AgentOutcome } from "../agents/runner";
import { fmtPeriod } from "../dates";
import { signedEuro } from "../format";
import type { DetectedOpportunity } from "../engine/types";

type Out = z.infer<typeof OutSchema>;
export type Narrative = { summary: string; recommendation: string; caveats: string[]; mode: "LLM" | "DETERMINISTIC"; model?: string; promptVersion?: string };
const OutSchema = z.object({ summary: z.string().min(20).max(700), recommendation: z.string().min(10).max(500), caveats: z.array(z.string().max(300)).max(4) });

export function deterministicNarrative(o: DetectedOpportunity): Narrative {
  const c = o.candidates[o.selected];
  const warns = c.audit.rules.filter((r) => r.outcome === "WARN").map((r) => r.detail);
  const rejected = o.candidates.filter((x) => x.audit.verdict === "REJECT");
  return {
    summary: `${o.signalText}. ${o.hypothesisText}`,
    recommendation: c.type === "NO_ACTION"
      ? `Ne rien faire pour l'instant : ${c.detail.charAt(0).toLowerCase()}${c.detail.slice(1)} Réévaluation prévue ${c.reviewAt ? "le " + c.reviewAt.split("-").reverse().join("/") : "à la prochaine revue"}.`
      : `${c.label}. ${c.detail}`,
    caveats: [
      ...warns,
      ...rejected.map((x) => `Option écartée par l'auditeur — ${x.label} : ${x.audit.rules.find((r) => r.outcome === "FAIL")?.detail ?? "garde-fou violé"}`),
      ...(c.expectedDeltaCents !== null && c.type !== "NO_ACTION" ? ["Le montant affiché est une simulation qui dépend de l'hypothèse de vente citée, pas un revenu acquis."] : []),
    ].slice(0, 4),
    mode: "DETERMINISTIC",
  };
}

/** Faits certifiés du dossier : tout ce que le modèle reçoit. Les montants viennent du moteur. */
function narrativeFacts(o: DetectedOpportunity, propertyName: string) {
  return {
    logement: propertyName, titre: o.title, periode: fmtPeriod(o.stayFrom, o.stayTo), signal: o.signalText, source: o.signalSource,
    diagnostic: o.diagnosis.primaryLabel, confiance: o.diagnosis.confidence, raisonnement: o.diagnosis.tree,
    preuves: o.diagnosis.evidence.map((e) => `${e.label} : ${e.value} (${e.source})`),
    hypotheses_alternatives: o.diagnosis.alternatives.map((a) => `${a.label} — ${a.why}`),
    options: o.candidates.map((c, i) => ({
      retenue: i === o.selected, libelle: c.label, detail: c.detail, ecart_contribution_simule: signedEuro(c.expectedDeltaCents), hypothese: c.hypothesis,
      audit: c.audit.verdict, regles_non_conformes: c.audit.rules.filter((r) => r.outcome !== "PASS").map((r) => r.detail),
    })),
    veto: o.veto ? o.vetoText : null,
  };
}

/**
 * Rédaction du dossier par la direction (US-074 : via l'exécuteur d'agent, donc prompt versionné, budget, trace et repli).
 * Les faits viennent du moteur ; le modèle ne fait que les expliquer. Sans modèle, la synthèse est celle des règles.
 */
export async function writeNarrative(budget: AgentBudget, o: DetectedOpportunity, propertyName: string, opportunityId: string): Promise<{ narrative: Narrative; outcome: AgentOutcome<Out> }> {
  const outcome = await runAgentTask<Out>({
    budget, agentId: "direction", opportunityId, operation: "explainAction", prompt: "direction.explain_action", schema: OutSchema,
    user: "Faits certifiés du dossier :\n" + JSON.stringify(narrativeFacts(o, propertyName), null, 1),
    summary: ({ mode, reason }) => `Synthèse du dossier « ${o.title} » ${mode === "LLM" ? "rédigée" : "composée par règles" + (reason && reason !== "NO_PROVIDER" ? " (repli : " + FALLBACK_LABEL[reason] + ")" : "")}.`,
    fallback: () => { const d = deterministicNarrative(o); return { summary: d.summary, recommendation: d.recommendation, caveats: d.caveats }; },
  });
  const narrative: Narrative = outcome.mode === "LLM" ? { ...outcome.data, mode: "LLM", model: outcome.run.model ?? undefined, promptVersion: outcome.run.promptVersion ?? undefined } : deterministicNarrative(o);
  return { narrative, outcome };
}
