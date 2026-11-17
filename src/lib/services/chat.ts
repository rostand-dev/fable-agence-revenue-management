import { and, desc, eq, isNull } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { AGENT_BY_ID, agentName, type AgentId } from "../agents/registry";
import { callLlm, HOUSE_RULES, PROMPT_VERSION, type LlmConfig, type LlmResult } from "../agents/llm";
import { trimToLastSentence } from "../agents/text";
import { resolveLlm } from "../agents/llm-config";
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

/** Longueur maximale d'une réponse de chat : assez large pour finir ses phrases, la consigne garde les réponses courtes. */
export const CHAT_MAX_TOKENS = 1000;

export type ChatContext = {
  tenantId: string; agentId: AgentId; opportunityId: string | null; question: string;
  llm: LlmConfig | null; system: string; messages: { role: "user" | "assistant"; content: string }[]; fallback: string;
};
export type ChatAnswer = { id: string; content: string; mode: "LLM" | "DETERMINISTIC"; createdAt: Date };

/** Prépare un échange : enregistre la question, rassemble le contexte et la réponse de repli. Rien n'est envoyé au fournisseur. */
export async function prepareChat(tenantId: string, agentIdRaw: string, opportunityId: string | null, question: string): Promise<ChatContext> {
  const agentId = (AGENT_BY_ID[agentIdRaw as AgentId] ? agentIdRaw : "direction") as AgentId;
  const a = AGENT_BY_ID[agentId];
  const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
  const o = opportunityId ? (await db.select().from(opportunities).where(and(eq(opportunities.id, opportunityId), eq(opportunities.tenantId, tenantId))))[0] ?? null : null;
  const history = (await db.select().from(chatMessages).where(and(eq(chatMessages.tenantId, tenantId), eq(chatMessages.agentId, agentId), opportunityId ? eq(chatMessages.opportunityId, opportunityId) : isNull(chatMessages.opportunityId))).orderBy(desc(chatMessages.createdAt)).limit(8)).reverse();
  await db.insert(chatMessages).values({ id: newId("msg"), tenantId, agentId, opportunityId: o ? opportunityId : null, role: "user", content: question });
  const fallback = deterministicAnswer(agentId, question, o);
  const llm = await resolveLlm(tenantId, agentId);
  let system = "";
  if (llm) {
    let context = `Ton poste : ${a.title}. Mission : ${a.mission}\nResponsabilités : ${a.responsibilities.join(" ; ")}\nDroits : ${a.rights}\nLimites : ${a.limits.join(" ; ")}`;
    if (o) {
      const [p] = await db.select().from(properties).where(eq(properties.id, o.propertyId));
      context += `\n\nDossier ${o.code} — ${p?.name} — ${o.title}\nPériode : ${fmtPeriod(o.stayFrom, o.stayTo)}\nSignal : ${o.signals.signalText}\nDiagnostic : ${o.diagnosis.primaryLabel} (confiance ${o.diagnosis.confidence})\nPreuves : ${(o.diagnosis.evidence as any[]).map((e) => `${e.label} : ${e.value}`).join(" | ")}\nOptions :\n` +
        (o.candidates as Candidate[]).map((c, i) => `- ${i === o.selected ? "[retenue] " : ""}${c.label} — écart de contribution simulé ${signedEuro(c.expectedDeltaCents)} — audit ${c.audit.verdict}${c.audit.rules.filter((r) => r.outcome !== "PASS").map((r) => " · " + r.detail).join("")}`).join("\n");
    } else {
      const runs = await db.select().from(agentRuns).where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.agentId, agentId))).orderBy(desc(agentRuns.createdAt)).limit(6);
      context += "\n\nTon activité récente :\n" + runs.map((r) => "- " + r.summary).join("\n");
    }
    system = `Tu es ${agentName(agentId, t?.settings?.agentNames)}, ${a.title.toLowerCase()} dans une agence de revenue management pour locations de courte durée. Tu réponds au propriétaire en 2 à 5 phrases, 120 mots au maximum, et tu termines toujours tes phrases.\n${HOUSE_RULES}\nSi la question sort de ton poste, dis quel collègue de l'agence est compétent. Si une donnée manque pour répondre, dis-le.\n\n${context}`;
  }
  return { tenantId, agentId, opportunityId: o ? opportunityId : null, question, llm, system, fallback,
    messages: [...history.map((m) => ({ role: m.role === "user" ? "user" as const : "assistant" as const, content: m.content })), { role: "user" as const, content: question }] };
}

/** Enregistre la réponse (et la trace d'activité). `r` = résultat du modèle, `err` = échec du fournisseur, aucun des deux = mode règles. */
export async function finishChat(c: ChatContext, r: LlmResult | null, err?: unknown): Promise<ChatAnswer> {
  let answer = c.fallback, mode: "LLM" | "DETERMINISTIC" = "DETERMINISTIC";
  if (c.llm && r) {
    if (r.text) { answer = r.truncated ? trimToLastSentence(r.text) : r.text; mode = "LLM"; }
    await db.insert(agentRuns).values({ id: newId("run"), tenantId: c.tenantId, agentId: c.agentId, opportunityId: c.opportunityId, operation: "chat", mode: "LLM", model: r.model, promptVersion: PROMPT_VERSION,
      summary: r.truncated ? "Réponse à une question du propriétaire, raccourcie à la dernière phrase complète (limite de longueur atteinte)." : "Réponse à une question du propriétaire.", inputTokens: r.inputTokens, outputTokens: r.outputTokens, durationMs: r.durationMs });
  } else if (c.llm && err) {
    await db.insert(agentRuns).values({ id: newId("run"), tenantId: c.tenantId, agentId: c.agentId, opportunityId: c.opportunityId, operation: "chat", mode: "DETERMINISTIC", model: c.llm.model, summary: "Réponse en repli déterministe : fournisseur LLM indisponible.", error: String((err as any)?.message ?? err).slice(0, 200) });
  }
  const id = newId("msg"), createdAt = new Date();
  await db.insert(chatMessages).values({ id, tenantId: c.tenantId, agentId: c.agentId, opportunityId: c.opportunityId, role: "agent", content: answer, mode, createdAt });
  return { id, content: answer, mode, createdAt };
}

/** Question à un agent (sans JavaScript côté navigateur). La réponse est une interprétation rattachée au dossier, jamais une pièce de preuve. */
export async function askAgent(tenantId: string, agentIdRaw: string, opportunityId: string | null, question: string): Promise<void> {
  const c = await prepareChat(tenantId, agentIdRaw, opportunityId, question);
  let r: LlmResult | null = null, err: unknown;
  if (c.llm) { try { r = await callLlm(c.llm, { system: c.system, messages: c.messages, maxTokens: CHAT_MAX_TOKENS }); } catch (e) { err = e; } }
  await finishChat(c, r, err);
}
