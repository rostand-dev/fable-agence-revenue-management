import type { HubCard } from "@/components/PropertyHub";
import { fmtEur } from "./cap-message";
import type { CapState } from "./cap-state";

/** `canDecide` : seul l'exploitant de la plateforme valide un prix (il est partagé par tous les comptes). */
export type IaHubFacts = { providers: number; providersTotal: number; customAgents: number; agentsTotal: number; cap: CapState; pending: number; canDecide: boolean };

function agentsLabel({ providers, customAgents: n, agentsTotal, cap }: IaHubFacts): string {
  if (!providers) return "Mode déterministe : aucune clé";
  if (cap.level === "reached") return "Mode déterministe : plafond atteint";
  if (!n) return "Automatique pour tous les agents";
  const chosen = `${n} agent${n > 1 ? "s" : ""} personnalisé${n > 1 ? "s" : ""}`;
  return n < agentsTotal ? `${chosen}, les autres en automatique` : chosen;
}

function pricesState({ pending: n, canDecide }: IaHubFacts): NonNullable<HubCard["state"]> {
  if (!n) return { role: "neutre", label: "Aucun prix à valider" };
  const prices = n > 1 ? `${n} nouveaux prix` : "1 nouveau prix";
  return canDecide ? { role: "attention", label: `${prices} à valider` } : { role: "neutre", label: `${prices} en attente de l'exploitant` };
}

/** Les quatre cartes de « IA & modèles » : l'état affiché vient des données, et « Vient de » dit où se trouvait le réglage. Pur. */
export function iaHubCards(facts: IaHubFacts): HubCard[] {
  const { providers, providersTotal, cap } = facts;
  return [
    { key: "cles", href: "/modeles/cles", title: "Clés fournisseurs", description: "Vos clés Anthropic, OpenAI et Mistral. Vos données ne partent que chez les fournisseurs dont vous avez saisi la clé.",
      state: { role: providers ? "sain" : "neutre", label: `${providers} / ${providersTotal} fournisseurs connectés` }, foot: "Vient de : Intégrations › Modèles de langage" },
    { key: "agents", href: "/modeles/agents", title: "Agents", description: "Prénom et modèle de chaque agent, ou mode Automatique (le modèle le moins cher qui convient).",
      state: { role: cap.level === "reached" && providers ? "attention" : "neutre", label: agentsLabel(facts) }, foot: "Vient de : Réglages › Prénoms de l'équipe, Modèles par agent" },
    { key: "budget", href: "/modeles/budget", title: "Budget", description: "Plafond mensuel de dépense en euros et coût du mois par agent.",
      state: { role: cap.level === "reached" ? "violation" : cap.level === "alert" ? "attention" : "neutre", label: `${fmtEur(cap.spentEur)} consommés ce mois · ${cap.capEur === null ? "aucun plafond" : `plafond ${fmtEur(cap.capEur)}`}` }, foot: "Vient de : Modèles › Plafond, Coût du mois par agent" },
    { key: "catalogue", href: "/modeles/catalogue", title: "Catalogue", description: "Les modèles disponibles avec vos clés, leur test manuel et la validation des nouveaux prix.",
      state: pricesState(facts), foot: "Vient de : Modèles › Modèles du catalogue" },
  ];
}
