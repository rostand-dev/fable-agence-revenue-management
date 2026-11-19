/** Génère docs/capacites-integrations.md depuis src/lib/integrations/capabilities.ts. Usage : npm run docs:capabilities */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderCapabilitiesMarkdown } from "../src/lib/integrations/capabilities-doc";

const target = resolve(__dirname, "../docs/capacites-integrations.md");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, renderCapabilitiesMarkdown());
console.log("Écrit : " + target);
