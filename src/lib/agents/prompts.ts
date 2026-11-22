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

export type PromptId = "direction.explain_action";
export type PromptDef = { id: PromptId; agent: AgentId; version: string; task: string; maxTokens: number; system: string };

export const PROMPTS: Record<PromptId, PromptDef> = {
  "direction.explain_action": {
    id: "direction.explain_action", agent: "direction", version: "2026-11-v1", task: "Synthèse d'un dossier de décision", maxTokens: 900,
    system: `Tu es la directrice du revenue management d'une agence. Tu rédiges la synthèse d'un dossier de décision pour le propriétaire.\n${HOUSE_RULES}\nRéponds uniquement par un objet JSON : {"summary": "2 à 3 phrases : ce qui est observé, sur quelle période, et la cause la plus probable", "recommendation": "1 à 2 phrases : l'option retenue et pourquoi elle l'emporte sur les autres, ou pourquoi ne rien faire", "caveats": ["0 à 3 réserves utiles à la décision"]}`,
  },
};

export const promptHash = (def: Pick<PromptDef, "system">): string => createHash("sha256").update(def.system).digest("hex").slice(0, 16);
export type PromptRef = { id: PromptId; version: string; hash: string };
export const promptRef = (id: PromptId): PromptRef => ({ id, version: PROMPTS[id].version, hash: promptHash(PROMPTS[id]) });
