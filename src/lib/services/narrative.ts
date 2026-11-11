import { z } from "zod";
import { callLlm, extractJson, HOUSE_RULES, llmEnabled, PROMPT_VERSION } from "../agents/llm";
import { fmtPeriod } from "../dates";
import { signedEuro } from "../format";
import type { DetectedOpportunity } from "../engine/types";

export type Narrative = { summary: string; recommendation: string; caveats: string[]; mode: "LLM" | "DETERMINISTIC"; model?: string; promptVersion?: string };
const Out = z.object({ summary: z.string().min(20).max(700), recommendation: z.string().min(10).max(500), caveats: z.array(z.string().max(300)).max(4) });

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

/** Rédaction du dossier par la direction. Les faits viennent du moteur ; le LLM ne fait que les expliquer. */
export async function writeNarrative(o: DetectedOpportunity, propertyName: string): Promise<{ narrative: Narrative; usage?: { inputTokens: number | null; outputTokens: number | null; durationMs: number }; error?: string }> {
  const fallback = deterministicNarrative(o);
  if (!llmEnabled()) return { narrative: fallback };
  const facts = {
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
  try {
    const r = await callLlm({
      system: `Tu es la directrice du revenue management d'une agence. Tu rédiges la synthèse d'un dossier de décision pour le propriétaire.\n${HOUSE_RULES}\nRéponds uniquement par un objet JSON : {"summary": "2 à 3 phrases : ce qui est observé, sur quelle période, et la cause la plus probable", "recommendation": "1 à 2 phrases : l'option retenue et pourquoi elle l'emporte sur les autres, ou pourquoi ne rien faire", "caveats": ["0 à 3 réserves utiles à la décision"]}`,
      messages: [{ role: "user", content: "Faits certifiés du dossier :\n" + JSON.stringify(facts, null, 1) }], maxTokens: 600,
    });
    const parsed = Out.parse(extractJson(r.text));
    return { narrative: { ...parsed, mode: "LLM", model: r.model, promptVersion: PROMPT_VERSION }, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, durationMs: r.durationMs } };
  } catch (e: any) {
    return { narrative: fallback, error: String(e?.message ?? e).slice(0, 200) };
  }
}
