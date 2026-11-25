import { describe, expect, it } from "vitest";
import { capState } from "./cap-state";
import { iaHubCards } from "./hub";

const cap = (capEur: number | null = null, spentUsd = 0) => capState(capEur, spentUsd, 1);
const base = { providers: 0, providersTotal: 3, customAgents: 0, agentsTotal: 8, cap: cap(), pending: 0, canDecide: true };
const states = (o: Partial<typeof base>) => Object.fromEntries(iaHubCards({ ...base, ...o }).map((c) => [c.key, c.state!]));

describe("hub IA & modèles", () => {
  it("quatre cartes, chacune avec son adresse, son état et son origine", () => {
    const cards = iaHubCards(base);
    expect(cards.map((c) => c.href)).toEqual(["/modeles/cles", "/modeles/agents", "/modeles/budget", "/modeles/catalogue"]);
    for (const c of cards) { expect(c.state).toBeTruthy(); expect(c.foot).toMatch(/^Vient de : /); }
  });
  it("sans clé ni dépense : rien n'est annoncé comme actif", () => {
    const s = states({});
    expect(s.cles).toEqual({ role: "neutre", label: "0 / 3 fournisseurs connectés" });
    expect(s.agents.label).toBe("Mode déterministe : aucune clé");
    expect(s.budget.label).toContain("aucun plafond");
    expect(s.catalogue).toEqual({ role: "neutre", label: "Aucun prix à valider" });
  });
  it("clés, agents personnalisés et prix en attente sont comptés", () => {
    const s = states({ providers: 2, customAgents: 1, pending: 2 });
    expect(s.cles).toEqual({ role: "sain", label: "2 / 3 fournisseurs connectés" });
    expect(s.agents.label).toBe("1 agent personnalisé, les autres en automatique");
    expect(states({ providers: 1, customAgents: 8 }).agents.label).toBe("8 agents personnalisés");
    expect(s.catalogue).toEqual({ role: "attention", label: "2 nouveaux prix à valider" });
    expect(states({ pending: 1, canDecide: false }).catalogue).toEqual({ role: "neutre", label: "1 nouveau prix en attente de l'exploitant" });
    expect(states({ providers: 1 }).agents.label).toBe("Automatique pour tous les agents");
  });
  it("le budget signale l'alerte et le plafond atteint", () => {
    expect(states({ cap: cap(10, 8.5) }).budget).toMatchObject({ role: "attention" });
    const reached = states({ cap: cap(10, 11) }).budget;
    expect(reached.role).toBe("violation");
    expect(states({ providers: 1, cap: cap(10, 11) }).agents).toEqual({ role: "attention", label: "Mode déterministe : plafond atteint" });
    expect(reached.label).toContain("plafond 10");
  });
});
