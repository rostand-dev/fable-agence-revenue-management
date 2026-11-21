// Lance le faux serveur de l'API PriceLabs pour les tests de bout en bout. Usage : npx tsx scripts/fake-pricelabs-server.ts
// Port : FAKE_PRICELABS_PORT (défaut 4010). L'application s'y branche avec PRICELABS_API_BASE=http://127.0.0.1:4010/v1.
import { startFakePriceLabsServer } from "../src/lib/integrations/pricelabs-fake-server";

const port = Number(process.env.FAKE_PRICELABS_PORT || 4010);
startFakePriceLabsServer({ port }).then((s) => console.log(`Faux serveur PriceLabs sur ${s.url}`)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
