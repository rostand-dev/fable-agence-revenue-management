/** Génère docs/regles-de-cumul.md depuis src/lib/stacking/rules.ts. Usage : npm run docs:stacking */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderStackingMarkdown } from "../src/lib/stacking/rules-doc";

const target = resolve(__dirname, "../docs/regles-de-cumul.md");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderStackingMarkdown());
console.log("Écrit : " + target);
