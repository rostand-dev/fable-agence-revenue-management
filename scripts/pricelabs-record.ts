// Enregistre les réponses réelles de PriceLabs pour UNE annonce, les rend anonymes et les écrit au format de fixture rejouable.
// Usage : PRICELABS_RECORD_KEY=<clé API> npx tsx scripts/pricelabs-record.ts <identifiant d'annonce> <fichier de sortie .json>
// Lecture seule (aucune écriture chez PriceLabs). La clé n'est jamais écrite. Noms, groupes, étiquettes et notes sont remplacés ;
// identifiants d'annonce et de réservations sont remplacés par des identifiants fictifs. À lancer sur votre poste : le serveur de développement n'a pas accès à PriceLabs.
import fs from "node:fs";
import { todayISO } from "../src/lib/dates";
import { horizon, HttpPriceLabs } from "../src/lib/integrations/pricelabs";
import { anonymizeScenario } from "../src/lib/integrations/pricelabs-record";
import type { Scenario } from "../src/lib/integrations/pricelabs-scenarios";

async function main() {
  const key = process.env.PRICELABS_RECORD_KEY?.trim(), [id, out] = process.argv.slice(2);
  if (!key || !id || !out) { console.error("Usage : PRICELABS_RECORD_KEY=<clé> npx tsx scripts/pricelabs-record.ts <annonce> <sortie.json>"); process.exit(2); }
  const raw: { listings?: any; prices?: any; neighborhood?: any; reservations?: any[] } = {};
  const port = new HttpPriceLabs(key, (endpoint, _req, body) => { if (endpoint === "listings") raw.listings = body; if (endpoint === "prices") raw.prices = body; if (endpoint === "neighborhood") raw.neighborhood = body; if (endpoint === "reservations") raw.reservations = body as any[]; });
  const listing = (await port.listListings()).find((l) => l.id === id);
  if (!listing) { console.error("Annonce introuvable sur ce compte."); process.exit(1); }
  const h = horizon(todayISO());
  await port.getPrices(listing.id, listing.pms, h.from, h.to);
  await port.getNeighborhood(listing.id, listing.pms);
  await port.getReservations(listing.id, listing.pms, h.histFrom, h.histTo);
  const priceItem = (Array.isArray(raw.prices) ? raw.prices : []).find((x: any) => String(x?.id) === id);
  const scenario: Scenario = anonymizeScenario({
    listings: (raw.listings?.listings ?? []).filter((l: any) => String(l.id) === id),
    prices: { [id]: priceItem }, neighborhood: { [id]: raw.neighborhood?.data ?? null }, reservations: { [id]: raw.reservations ?? [] },
  });
  fs.writeFileSync(out, JSON.stringify({ meta: { recordedAt: new Date().toISOString(), note: "Enregistrement réel anonymisé." }, scenario }, null, 1) + "\n");
  console.log("écrit :", out);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
