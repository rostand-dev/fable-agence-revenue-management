/**
 * Faux serveur de modèle de langage pour les tests E2E (aucune clé, aucun réseau externe). Lancé par Playwright quand ANTHROPIC_API_BASE pointe vers cette machine ;
 * l'application le lit comme elle lirait Anthropic. Port : FAKE_LLM_PORT (défaut 4011).
 */
import { e2eFakeReply } from "../src/lib/agents/fake-llm-responder";
import { startFakeLlmServer } from "../src/lib/agents/fake-llm-server";

const port = Number(process.env.FAKE_LLM_PORT || 4011);
startFakeLlmServer((req) => e2eFakeReply(req), port).then((s) => console.log(`faux serveur de modèle prêt sur ${s.url}`));
