import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * US-075 — Aucune écriture externe depuis les agents (ADR-005, principe 4 de l'épic 7).
 * Contrôle statique : les modules d'agents n'importent aucun adaptateur d'intégration ni service d'écriture, n'écrivent pas en base
 * (les traces sont insérées par l'appelant) et ne contactent que les API de modèles. Un nouvel import hors de la liste fait échouer la CI :
 * il doit être justifié et ajouté ici, en relecture.
 */
const DIR = __dirname;
const modules = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !/\.test\.ts$/.test(f));
const src = (f: string) => readFileSync(join(DIR, f), "utf8");
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Imports autorisés hors fichiers voisins (./…) : types et fonctions pures, le masquage, le chiffrement des clés, la base (lecture des clés et du budget). */
const ALLOWED = new Set(["zod", "node:crypto", "node:http", "node:net", "drizzle-orm", "@/db", "../dates", "../format", "../privacy/pii", "../secret", "../engine/types", "../engine/policy"]);

describe("agents : aucune écriture externe (US-075)", () => {
  it("la liste des modules d'agents est non vide et couvre les agents de l'épic", () => {
    for (const f of ["gateway.ts", "market-analyst.ts", "strategist.ts", "auditor.ts", "runner.ts"]) expect(modules, f).toContain(f);
  });

  it("chaque import d'un module d'agent est dans la liste autorisée (aucun adaptateur d'intégration, aucun service)", () => {
    for (const f of modules) {
      // « import x from "…" », « export … from "…" » et les imports à effet de bord « import "…" »
      const specs = [...code(f).matchAll(/(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
      for (const s of specs) {
        if (s.startsWith("./")) continue;
        expect(ALLOWED.has(s), `${f} importe « ${s} » : interdit pour un module d'agent (ajouter ici seulement après relecture)`).toBe(true);
      }
      expect(code(f), `${f} : import dynamique interdit`).not.toMatch(/\bimport\s*\(/);
      expect(code(f), `${f} : require interdit`).not.toMatch(/\brequire\s*\(/);
    }
  });

  it("aucun module d'agent n'écrit en base : les traces sont insérées par l'appelant (revue)", () => {
    for (const f of modules) expect(code(f), f).not.toMatch(/\bdb\s*\.\s*(insert|update|delete)\b|\.execute\s*\(/);
  });

  it("seuls la passerelle et le transport Anthropic appellent le réseau, et seulement vers des API de modèles", () => {
    const net = modules.filter((f) => /\bfetch\s*\(|node:https?|XMLHttpRequest|WebSocket/.test(code(f)) && f !== "fake-llm-server.ts");
    expect(net.sort()).toEqual(["gateway.ts", "llm.ts"]);
    for (const f of net) {
      const hosts = [...code(f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
      for (const h of hosts) expect(["api.anthropic.com", "api.openai.com"], `${f} contacte ${h}`).toContain(h);
    }
  });

  it("le faux serveur de modèle n'écoute qu'en local", () => {
    expect(src("fake-llm-server.ts")).toMatch(/127\.0\.0\.1/);
    expect(code("fake-llm-server.ts")).not.toMatch(/listen\s*\(\s*(port|0)\s*\)/);
  });

  it("le port PriceLabs n'a aucune méthode d'écriture (l'écriture relève de l'épic 9)", () => {
    const port = readFileSync(join(DIR, "../integrations/pricelabs-port.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const methods = [...port.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]);
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) expect(m, "méthode d'écriture dans le port").not.toMatch(/^(set|put|post|patch|delete|update|write|push|create|remove|apply)/i);
  });
});
