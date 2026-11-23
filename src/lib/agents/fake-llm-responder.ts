/**
 * Réponses du faux serveur de modèle pour les tests de bout en bout (E2E) : valides, déterministes et sans aucun chiffre inventé.
 * Chaque tâche est reconnue par une phrase de son prompt système. Une tâche inconnue reçoit une réponse inexploitable (l'application doit alors se replier).
 */
import type { FakeLlmReply, FakeLlmRequest } from "./fake-llm-server";

export function e2eFakeReply(req: FakeLlmRequest): FakeLlmReply {
  if (req.body?.stream) return "Réponse de test de l'agent, fondée sur les faits du dossier.";
  if (req.system.includes("analyste marché")) {
    const ids = Array.from(req.user.matchAll(/^(E\d{1,2}) \[/gm)).map((m) => m[1]);
    if (ids.length === 0) return "{}";
    return JSON.stringify({
      findings: [{ statement: "Les pièces citées décrivent la situation observée sur la période étudiée.", evidence: ids.slice(0, 2), confidence: "MOYENNE" }],
      unknowns: [], hypotheses: [],
    });
  }
  if (req.system.includes("stratège tarifaire") || req.system.includes("responsable distribution et promotions")) {
    const ids = Array.from(req.user.matchAll(/^(O\d{1,2}) /gm)).map((m) => m[1]);
    if (ids.length === 0) return "{}";
    const verdictOf = (id: string) => /verdict de l'auditeur : (\w+)/.exec(req.user.split("\n").find((l) => l.startsWith(id + " ")) ?? "")?.[1];
    return JSON.stringify({ opinions: ids.map((id) => ({
      option: id, stance: verdictOf(id) === "APPROVE" ? "FAVORABLE" : verdictOf(id) === "REJECT" ? "DEFAVORABLE" : "RESERVES",
      rationale: "Cette option a été simulée puis auditée par le moteur, son avis suit le verdict de l'auditeur.", watchpoints: ["Mesurer l'effet sur la fenêtre d'observation prévue."],
    })) });
  }
  if (req.system.includes("directrice du revenue management")) {
    return JSON.stringify({ summary: "Le rythme de réservation observé sur la période étudiée justifie un examen de ce dossier.", recommendation: "Retenir l'option du moteur, déjà simulée et auditée.", caveats: ["Le montant affiché est une simulation."] });
  }
  return "{}";
}
