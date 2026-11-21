import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Garde (US-024) : seuls le lancement (parcours de création) et l'activation (checklist de qualité) écrivent le statut d'un logement.
 * Toute autre écriture `update(properties).set({ … status … })` contournerait la checklist ou pourrait rétrograder un logement actif.
 */
const ALLOWED = new Set(["src/app/actions/onboarding.ts", "src/lib/services/quality.ts"]);
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.|\/test\//.test(e.name) ? [path.join(dir, e.name)] : []);
}
describe("écritures du statut d'un logement", () => {
  it("restent confinées au lancement et à l'activation", () => {
    const bad: string[] = [];
    for (const f of files("src")) {
      const rel = f.split(path.sep).join("/");
      const src = fs.readFileSync(f, "utf8");
      const re = /\.update\(\s*(?:schema\.)?properties\s*\)\s*\.set\(\{([\s\S]*?)\}\)\s*\.where/g;
      for (let m; (m = re.exec(src)); ) if (/\bstatus\s*:/.test(m[1]) && !ALLOWED.has(rel)) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});
