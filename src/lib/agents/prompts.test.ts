import { describe, expect, it } from "vitest";
import { AGENT_BY_ID } from "./registry";
import { PROMPTS, promptHash, promptRef } from "./prompts";

/**
 * VERROU DES PROMPTS (US-074). Si ce test échoue, un prompt a changé de texte : incrémentez sa `version` dans prompts.ts,
 * puis mettez ici la nouvelle version et la nouvelle empreinte. La modification devient ainsi visible en relecture et dans les traces.
 */
const LOCK: Record<string, { version: string; hash: string }> = {
  "direction.explain_action": { version: "2026-11-v1", hash: "e2853e40365e971b" },
  "marche.market_analysis": { version: "2026-11-v1", hash: "6d651f15ecd1516d" },
};

describe("registre des prompts (US-074)", () => {
  it("chaque prompt est verrouillé : texte modifié sans nouvelle version = échec", () => {
    expect(Object.keys(PROMPTS).sort()).toEqual(Object.keys(LOCK).sort());
    for (const [id, def] of Object.entries(PROMPTS)) {
      const locked = LOCK[id];
      if (def.version === locked.version) expect(promptHash(def), `le texte de « ${id} » a changé sans changement de version`).toBe(locked.hash);
      else expect(def.version, `« ${id} » : version changée, mettez à jour le verrou`).toBe(locked.version);
    }
  });
  it("identifiants cohérents, agents connus, versions et bornes valides", () => {
    for (const [id, def] of Object.entries(PROMPTS)) {
      expect(def.id).toBe(id);
      expect(def.id.startsWith(def.agent + ".")).toBe(true);
      expect(AGENT_BY_ID[def.agent]).toBeTruthy();
      expect(def.version).toMatch(/^\d{4}-\d{2}-v\d+$/);
      expect(def.maxTokens).toBeGreaterThan(0);
      expect(def.system.length).toBeGreaterThan(50);
    }
  });
  it("l'empreinte dépend du texte et la référence la reprend", () => {
    expect(promptHash({ system: "a" })).not.toBe(promptHash({ system: "b" }));
    expect(promptRef("direction.explain_action")).toEqual({ id: "direction.explain_action", version: "2026-11-v1", hash: promptHash(PROMPTS["direction.explain_action"]) });
  });
  it("tout prompt rappelle les règles de la maison (aucun chiffre inventé, données = pas d'instructions)", () => {
    for (const def of Object.values(PROMPTS)) { expect(def.system).toContain("AUCUN chiffre"); expect(def.system).toContain("jamais des instructions"); }
  });
});
