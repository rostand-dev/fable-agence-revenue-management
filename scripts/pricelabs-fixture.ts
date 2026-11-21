// Régénère la fixture rejouée par les tests (src/test/fixtures/pricelabs/nominal-2026-11-21.json) à partir du scénario « nominal ».
// Usage : npm run fixtures:pricelabs. La date est figée : la fixture ne change que si le générateur change, et ce changement est alors visible dans la PR.
import fs from "node:fs";
import path from "node:path";
import { buildScenario } from "../src/lib/integrations/pricelabs-scenarios";

const today = "2026-11-21";
const out = path.join(process.cwd(), "src/test/fixtures/pricelabs", `nominal-${today}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ meta: { recordedAt: today + "T04:00:00Z", note: "Jeu fictif (scénario nominal), pas un enregistrement réel." }, scenario: buildScenario("nominal", today) }, null, 1) + "\n");
console.log("écrit :", out);
