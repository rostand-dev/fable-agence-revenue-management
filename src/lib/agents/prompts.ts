/**
 * Registre des prompts d'agents (US-074). Chaque tâche confiée à un modèle a un identifiant, une VERSION et une EMPREINTE (SHA-256 du texte système).
 * La version et l'empreinte sont enregistrées avec chaque appel (table agent_runs) : on sait toujours quel texte a produit quelle sortie.
 *
 * Verrou : `prompts.test.ts` compare chaque empreinte à une valeur figée. Modifier le texte d'un prompt sans changer sa version fait échouer le test :
 * il faut alors incrémenter `version` ET mettre à jour le verrou, ce qui rend la modification visible en relecture.
 */
import { createHash } from "node:crypto";
import { HOUSE_RULES } from "./llm";
import type { AgentId } from "./registry";

export type PromptId = "direction.explain_action" | "marche.market_analysis";
export type PromptDef = { id: PromptId; agent: AgentId; version: string; task: string; maxTokens: number; system: string };

export const PROMPTS: Record<PromptId, PromptDef> = {
  "direction.explain_action": {
    id: "direction.explain_action", agent: "direction", version: "2026-11-v1", task: "Synthèse d'un dossier de décision", maxTokens: 900,
    system: `Tu es la directrice du revenue management d'une agence. Tu rédiges la synthèse d'un dossier de décision pour le propriétaire.\n${HOUSE_RULES}\nRéponds uniquement par un objet JSON : {"summary": "2 à 3 phrases : ce qui est observé, sur quelle période, et la cause la plus probable", "recommendation": "1 à 2 phrases : l'option retenue et pourquoi elle l'emporte sur les autres, ou pourquoi ne rien faire", "caveats": ["0 à 3 réserves utiles à la décision"]}`,
  },
  "marche.market_analysis": {
    id: "marche.market_analysis", agent: "marche", version: "2026-11-v1", task: "Constats de marché référencés", maxTokens: 900,
    system: `Tu es l'analyste marché d'une agence de revenue management. Tu transformes les pièces d'un dossier en constats factuels, sans jamais conclure au-delà des données.\n${HOUSE_RULES}\nRègles propres à ton poste :\n- Chaque constat cite une à quatre preuves par leur numéro (E1, E2…), prises uniquement dans la liste fournie.\n- Tu constates, tu ne proposes aucune action ni aucun prix : c'est le rôle des stratèges.\n- Une corrélation n'est jamais présentée comme une cause : tu écris « coïncide avec », « est associé à ».\n- Ce que les pièces ne permettent pas de savoir va dans « unknowns » ; tu ne le devines pas.\n- Les hypothèses concurrentes viennent des pièces ; tu n'en inventes pas.\nRéponds uniquement par un objet JSON : {"findings": [{"statement": "constat factuel en une phrase", "evidence": ["E1"], "confidence": "HAUTE|MOYENNE|FAIBLE"}], "unknowns": ["ce qui reste inconnu"], "hypotheses": [{"label": "hypothèse concurrente", "evidence": ["E2"]}]}`,
  },
};

export const promptHash = (def: Pick<PromptDef, "system">): string => createHash("sha256").update(def.system).digest("hex").slice(0, 16);
export type PromptRef = { id: PromptId; version: string; hash: string };
export const promptRef = (id: PromptId): PromptRef => ({ id, version: PROMPTS[id].version, hash: promptHash(PROMPTS[id]) });
