/** Génère docs/dictionnaire-montants.md depuis src/lib/money/dictionary.ts. Usage : npm run docs:money */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderDictionaryMarkdown } from "../src/lib/money/render";

const target = resolve(__dirname, "../docs/dictionnaire-montants.md");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderDictionaryMarkdown());
console.log("Écrit : " + target);
