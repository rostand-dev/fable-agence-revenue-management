import { Client } from "pg";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";

// écrans réservés à l'ordinateur : testés en version complète à toutes les largeurs
test.use(VERSION_COMPLETE);

// US-021 : mapping des identifiants externes. Les trois projets (bureau, mobile 390 et 360) partagent le même compte : chaque test crée son propre logement.
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const numeric = (info: TestInfo) => String(Math.floor(10_000_000 + Math.random() * 89_000_000)) + info.workerIndex % 10;

async function createViaApi(page: Page, name: string) {
  const res = await page.request.post("/api/v1/properties", { data: { name, city: "Lille", kind: "T2", bedrooms: 2, capacity: 4 } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}
/** Rattache une annonce PriceLabs sans appeler PriceLabs : écrit directement la connexion (comme après « Choisir cette annonce »). */
async function linkPriceLabs(propertyId: string, city: string) {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { await c.query("update properties set pricelabs = $2::jsonb where id = $1", [propertyId, JSON.stringify({ apiKeyEnc: "x", listingId: "pl-" + propertyId, pms: "superhote", listingName: "Annonce E2E", candidates: [{ id: "pl-" + propertyId, pms: "superhote", name: "Annonce E2E", city, bedrooms: 2 }] })]); }
  finally { await c.end(); }
}

test("Mapping : un logement sans PriceLabs est incomplet et non confirmable ; les annonces s'y reflètent", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const id = await createViaApi(page, `Mapping ${uid(info)}`);
  await page.goto(`/logements/${id}/mapping`);
  await expect(page.getByRole("heading", { level: 1, name: "Mapping des identifiants" })).toBeVisible();
  await expect(page.getByTestId("mapping-status")).toContainText("Incomplet");
  await expect(page.getByTestId("mapping-pricelabs")).toContainText("non renseigné");
  await expect(page.getByText("Pas encore confirmable")).toBeVisible();
  await expect(page.getByRole("button", { name: /Confirmer le mapping/ })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "/mapping incomplet");
  const air = numeric(info);
  const res = await page.request.post(`/api/v1/properties/${id}/listings`, { data: { channel: "AIRBNB", externalId: air } });
  expect(res.status(), await res.text()).toBe(201);
  await page.reload();
  await expect(page.getByTestId("mapping-airbnb")).toContainText(air);
  const api = await page.request.get(`/api/v1/properties/${id}/mapping`);
  expect(await api.json()).toMatchObject({ status: "INCOMPLETE", confirmable: false, missingRequired: ["pricelabs"] });
  const refused = await page.request.post(`/api/v1/properties/${id}/mapping`, { data: {} });
  expect(refused.status()).toBe(400);
  // le lien est proposé depuis la fiche du logement
  await page.goto(`/logements/${id}?tab=annonces`);
  await expect(page.getByRole("link", { name: "Mapping des identifiants" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Mapping : écarts signalés, confirmation assumée, confirmation périmée quand un identifiant change", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Rattachement PriceLabs simulé en base : DATABASE_URL requis.");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const id = await createViaApi(page, `Mapping ${uid(info)}`);
  await linkPriceLabs(id, "Lyon"); // le logement est à Lille : écart
  await page.goto(`/logements/${id}/mapping`);
  await expect(page.getByTestId("mapping-status")).toContainText("À confirmer");
  await expect(page.getByTestId("mapping-checks")).toContainText("Lyon");
  await expect(page.getByTestId("mapping-pricelabs")).toContainText("à vérifier");
  await expectNoHorizontalOverflow(page, "/mapping avec écart");
  // sans coche, la confirmation est refusée
  await page.getByRole("button", { name: "Confirmer le mapping" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "J'ai vérifié ces écarts" })).toBeVisible();
  await page.getByLabel(/J'ai vérifié ces écarts/).check();
  await page.getByRole("button", { name: "Confirmer le mapping" }).click();
  await expect(page.getByTestId("mapping-status")).toContainText("Confirmé");
  // un identifiant change : la confirmation tombe
  const res = await page.request.post(`/api/v1/properties/${id}/listings`, { data: { channel: "BOOKING", externalId: numeric(info).slice(0, 8) } });
  expect(res.status(), await res.text()).toBe(201);
  await page.reload();
  await expect(page.getByTestId("mapping-status")).toContainText("À reconfirmer");
  await expect(page.getByText("Un identifiant a changé depuis la dernière confirmation")).toBeVisible();
  await expectNoHorizontalOverflow(page, "/mapping périmé");
  expect(errors).toEqual([]);
});
