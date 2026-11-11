import { and, desc, eq, isNull } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { AGENT_BY_ID, agentName, type AgentId } from "../agents/registry";
import { callLlm, HOUSE_RULES, llmEnabled, PROMPT_VERSION } from "../agents/llm";
import { fmtPeriod } from "../dates";
import { signedEuro } from "../format";
import type { Candidate } from "../engine/types";

const { chatMessages, opportunities, agentRuns, tenants, properties } = schema;

function deterministicAnswer(agentId: AgentId, q: string, o: typeof opportunities.$inferSelect | null): string {
  const a = AGENT_BY_ID[agentId], t = q.toLowerCase();
  if (o) {
    const cands = o.candidates as Candidate[], sel = cands[o.selected];
    if (/inaction|rien|attendre/.test(t)) {
      const na = cands.find((c) => c.type === "NO_ACTION");
      if (!na) return "L'inaction n'a pas été instruite sur ce dossier.";
      const fail = na.audit.rules.find((r) => r.outcome !== "PASS");
      return `Si rien n'est décidé, la situation actuelle est maintenue. ${na.detail} ${fail ? "Avis de l'auditeur : " + fail.detail : "L'auditeur ne relève aucun garde-fou violé par l'inaction."}`;
    }
    if (/preuve|source|donn[ée]e/.test(t)) return "Pièces du dossier : " + (o.diagnosis.evidence as any[]).map((e) => `${e.label} — ${e.value} (${e.source})`).join(" ; ") + ".";
    if (/risque|plancher|audit|veto/.test(t)) return `Verdict de l'auditeur sur l'option retenue : ${sel.audit.verdict === "APPROVE" ? "conforme" : sel.audit.verdict === "REJECT" ? "rejetée" : "validation commentée requise"}. ` + sel.audit.rules.map((r) => `${r.label} : ${r.detail}`).join(" ");
    if (/pourquoi|expliqu|cause|raison/.test(t)) return `${o.narrative?.summary ?? ""} ${o.narrative?.recommendation ?? ""} Diagnostic : ${o.diagnosis.primaryLabel}. ${o.diagnosis.confidenceNote}`;
    return `Je peux répondre ici sur quatre points du dossier ${o.code} : pourquoi cette recommandation, ce qui se passe en cas d'inaction, les preuves, et l'avis de l'auditeur. Les réponses libres demandent une clé API (voir Réglages) ; sans elle, je m'en tiens aux faits du dossier.`;
  }
  if (/fais|rôle|mission|sers/.test(t)) return `${a.mission} Mes droits : ${a.rights}`;
  if (/limite|jamais|interdit/.test(t)) return "Mes limites : " + a.limits.join(" ; ") + ".";
  if (/quand|cadence|fréquence/.test(t)) return `Cadence : ${a.cadence}.`;
  return `Sans clé API, je réponds seulement sur mon rôle, mes limites et ma cadence. Mission : ${a.mission}`;
}

/** Question à un agent. La réponse est une interprétation rattachée au dossier, jamais une pièce de preuve. */
export async function askAgent(tenantId: string, agentIdRaw: string, opportunityId: string | null, question: string): Promise<void> {
  const agentId = (AGENT_BY_ID[agentIdRaw as AgentId] ? agentIdRaw : "direction") as AgentId;
  const a = AGENT_BY_ID[agentId];
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  const o = opportunityId ? (await db.select().from(opportunities).where(and(eq(opportunities.id, opportunityId), eq(opportunities.tenantId, tenantId))))[0] ?? null : null;
  const history = (await db.select().from(chatMessages).where(and(eq(chatMessages.tenantId, tenantId), eq(chatMessages.agentId, agentId), opportunityId ? eq(chatMessages.opportunityId, opportunityId) : isNull(chatMessages.opportunityId))).orderBy(desc(chatMessages.createdAt)).limit(8)).reverse();
  await db.insert(chatMessages).values({ id: newId("msg"), tenantId, agentId, opportunityId, role: "user", content: question });
  let answer = deterministicAnswer(agentId, question, o), mode = "DETERMINISTIC";
  if (llmEnabled()) {
    try {
      let context = `Ton poste : ${a.title}. Mission : ${a.mission}\nResponsabilités : ${a.responsibilities.join(" ; ")}\nDroits : ${a.rights}\nLimites : ${a.limits.join(" ; ")}`;
      if (o) {
        const [p] = await db.select().from(properties).where(eq(properties.id, o.propertyId));
        context += `\n\nDossier ${o.code} — ${p?.name} — ${o.title}\nPériode : ${fmtPeriod(o.stayFrom, o.stayTo)}\nSignal : ${o.signals.signalText}\nDiagnostic : ${o.diagnosis.primaryLabel} (confiance ${o.diagnosis.confidence})\nPreuves : ${(o.diagnosis.evidence as any[]).map((e) => `${e.label} : ${e.value}`).join(" | ")}\nOptions :\n` +
          (o.candidates as Candidate[]).map((c, i) => `- ${i === o.selected ? "[retenue] " : ""}${c.label} — écart de contribution simulé ${signedEuro(c.expectedDeltaCents)} — audit ${c.audit.verdict}${c.audit.rules.filter((r) => r.outcome !== "PASS").map((r) => " · " + r.detail).join("")}`).join("\n");
      } else {
        const runs = await db.select().from(agentRuns).where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.agentId, agentId))).orderBy(desc(agentRuns.createdAt)).limit(6);
        context += "\n\nTon activité récente :\n" + runs.map((r) => "- " + r.summary).join("\n");
      }
      const r = await callLlm({
        system: `Tu es ${agentName(agentId, t?.settings?.agentNames)}, ${a.title.toLowerCase()} dans une agence de revenue management pour locations de courte durée. Tu réponds au propriétaire en 2 à 5 phrases.\n${HOUSE_RULES}\nSi la question sort de ton poste, dis quel collègue de l'agence est compétent. Si une donnée manque pour répondre, dis-le.\n\n${context}`,
        messages: [...history.map((m) => ({ role: m.role === "user" ? "user" as const : "assistant" as const, content: m.content })), { role: "user", content: question }], maxTokens: 500,
      });
      if (r.text) { answer = r.text; mode = "LLM"; }
      await db.insert(agentRuns).values({ id: newId("run"), tenantId, agentId, opportunityId, operation: "chat", mode: "LLM", model: r.model, promptVersion: PROMPT_VERSION, summary: "Réponse à une question du propriétaire.", inputTokens: r.inputTokens, outputTokens: r.outputTokens, durationMs: r.durationMs });
    } catch (e: any) {
      await db.insert(agentRuns).values({ id: newId("run"), tenantId, agentId, opportunityId, operation: "chat", mode: "DETERMINISTIC", summary: "Réponse en repli déterministe : fournisseur LLM indisponible.", error: String(e?.message ?? e).slice(0, 200) });
    }
  }
  await db.insert(chatMessages).values({ id: newId("msg"), tenantId, agentId, opportunityId, role: "agent", content: answer, mode });
}
