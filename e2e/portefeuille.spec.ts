import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";
import { useCreated } from "./helpers/properties";

/** supprimés après chaque test */
const toRemove = useCreated();

// écrans réservés à l'ordinateur : testés en version complète à toutes les largeurs
test.use(VERSION_COMPLETE);

// US-020 : propriétaires, logements, annonces, API REST. Les trois projets (bureau, mobile 390 et 360) partagent le même compte : chaque test crée ses propres données, au nom unique.
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** Ouvre une carte repliable seulement si elle ne l'est pas déjà (l'état ouvert survit à l'actualisation de la page). */
const open = async (card: Locator) => { if (!(await card.evaluate((el) => (el as HTMLDetailsElement).open))) await card.locator("summary").click(); };
const numeric = (info: TestInfo) => String(Math.floor(10_000_000 + Math.random() * 89_000_000)) + info.workerIndex % 10;

async function createViaApi(page: Page, name: string, extra: Record<string, unknown> = {}) {
  const res = await page.request.post("/api/v1/properties", { data: { name, city: "Lille", kind: "T2", ...extra } });
  expect(res.status(), await res.text()).toBe(201);
  return toRemove.property((await res.json()).id as string);
}

test("Propriétaires : ajouter, modifier, supprimer, sans débordement", async ({ page }, info) => {
  const name = `Proprio ${uid(info)}`, renamed = name + " bis";
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/proprietaires");
  await expect(page.getByRole("heading", { level: 1, name: "Propriétaires" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/proprietaires");
  // un nom trop court est refusé près du formulaire
  await page.locator("#new-name").fill("A");
  await page.locator("#new-name").evaluate((el: HTMLInputElement) => el.removeAttribute("required"));
  await page.getByRole("button", { name: "Ajouter le propriétaire" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "au moins 2 caractères" })).toBeVisible();
  // ajout
  await page.locator("#new-name").fill(name);
  await page.locator("#new-email").fill("proprio@example.test");
  await page.getByRole("button", { name: "Ajouter le propriétaire" }).click();
  const card = page.getByTestId("owner-card").filter({ hasText: name });
  await expect(card).toBeVisible();
  await expect(card).toContainText("0 logement");
  // modification
  await open(card);
  await card.locator("input[name=name]").fill(renamed);
  await card.getByRole("button", { name: "Enregistrer" }).click();
  const renamedCard = page.getByTestId("owner-card").filter({ hasText: renamed });
  await expect(renamedCard).toBeVisible();
  await expectNoHorizontalOverflow(page, "/proprietaires ouvert");
  // suppression
  await open(renamedCard);
  await renamedCard.getByRole("button", { name: "Supprimer ce propriétaire" }).click();
  await expect(page.getByTestId("owner-card").filter({ hasText: renamed })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Logement : création par l'API, propriétaire choisi dans le parcours, annonces, suppression", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const owner = `Proprio ${uid(info)}`, prop = `Logement ${uid(info)}`;
  // un second propriétaire rend le choix visible dans le parcours
  const o = await page.request.post("/api/v1/owners", { data: { name: owner } });
  expect(o.status()).toBe(201);
  const ownerId = toRemove.owner((await o.json()).id as string);
  const id = await createViaApi(page, prop);

  // le propriétaire se choisit à l'étape « Le logement » du parcours
  await page.goto(`/logements/${id}/creation?etape=logement`);
  await expectNoHorizontalOverflow(page, "parcours, étape logement");
  await page.locator("#ownerId").selectOption({ label: owner });
  await page.getByRole("button", { name: "Continuer" }).click();
  await page.waitForURL(/etape=superhote/);
  const got = await (await page.request.get(`/api/v1/properties/${id}`)).json();
  expect(got.ownerId).toBe(ownerId);

  // fiche du logement : propriétaire affiché, onglet Annonces
  await page.goto(`/logements/${id}?tab=annonces`);
  await expect(page.getByTestId("property-owner")).toContainText(owner);
  await expect(page.getByText("Aucune annonce enregistrée")).toBeVisible();
  await expectNoHorizontalOverflow(page, "fiche, onglet Annonces (vide)");
  const airbnbId = numeric(info);
  await page.locator("#new-listing-channel").selectOption("AIRBNB");
  await page.locator("#new-listing-url").fill(`https://www.airbnb.fr/rooms/${airbnbId}?adults=2`);
  await page.getByRole("button", { name: "Ajouter l'annonce" }).click();
  const card = page.getByTestId("listing-card").filter({ hasText: "Airbnb" });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`n° ${airbnbId}`);   // identifiant déduit de l'adresse
  // une deuxième annonce active sur le même canal est refusée avec une explication
  await page.locator("#new-listing-channel").selectOption("AIRBNB");
  await page.getByRole("button", { name: "Ajouter l'annonce" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "déjà une annonce active sur Airbnb" })).toBeVisible();
  // archivage puis rétablissement
  await open(card);
  await expectNoHorizontalOverflow(page, "fiche, annonce ouverte");
  await card.getByRole("button", { name: "Archiver" }).click();
  await expect(page.getByTestId("listing-card").filter({ hasText: "archivée" })).toBeVisible();
  await open(page.getByTestId("listing-card").first());
  await page.getByTestId("listing-card").first().getByRole("button", { name: "Rétablir" }).click();
  await expect(page.getByTestId("listing-card").filter({ hasText: "active" })).toBeVisible();
  // suppression de l'annonce
  await open(page.getByTestId("listing-card").first());
  await page.getByTestId("listing-card").first().getByRole("button", { name: "Supprimer" }).click();
  await expect(page.getByText("Aucune annonce enregistrée")).toBeVisible();

  // suppression du logement : le nom exact est exigé
  await page.goto(`/logements/${id}/supprimer`);
  await expectNoHorizontalOverflow(page, "page de suppression");
  await page.locator("#confirmName").fill("pas le bon nom");
  await page.getByRole("button", { name: "Supprimer définitivement" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "saisissez exactement le nom" })).toBeVisible();
  await page.locator("#confirmName").fill(prop);
  await page.getByRole("button", { name: "Supprimer définitivement" }).click();
  await page.waitForURL(/\/logements\?supprime=1/);
  await expect(page.getByText("Logement supprimé", { exact: true })).toBeVisible();
  expect((await page.request.get(`/api/v1/properties/${id}`)).status()).toBe(404);
  await page.request.delete(`/api/v1/owners/${ownerId}`);
  expect(errors).toEqual([]);
});

test("Compte & sécurité : le nom de l'espace se modifie, une valeur invalide est refusée", async ({ page }) => {
  await page.goto("/parametres/compte");
  const field = page.locator("#tenantName");
  const current = await field.inputValue();
  await field.evaluate((el: HTMLInputElement) => { el.removeAttribute("minlength"); });
  await field.fill("x");
  await page.getByRole("button", { name: "Enregistrer le nom" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "entre 2 et 80" })).toBeVisible();
  await field.fill(current);
  await page.getByRole("button", { name: "Enregistrer le nom" }).click();
  await expect(page.getByText("Nom de l'espace enregistré.")).toBeVisible();
  await expectNoHorizontalOverflow(page, "/parametres/compte");
});

test("API REST : session obligatoire, origine contrôlée, erreurs lisibles, aucun secret exposé", async ({ page, browser, baseURL }, info) => {
  // sans session : 401
  const anon = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  for (const [m, p] of [["get", "/api/v1/properties"], ["get", "/api/v1/owners"], ["post", "/api/v1/properties"], ["get", "/api/v1/properties/x/listings"]] as const) {
    const r = await (anon.request as any)[m](p, m === "post" ? { data: {} } : undefined);
    expect(r.status(), `${m} ${p}`).toBe(401);
    expect((await r.json()).error.code).toBe("UNAUTHENTICATED");
  }
  await anon.close();

  // une requête qui modifie depuis une autre origine est refusée
  const evil = await page.request.post("/api/v1/owners", { data: { name: "Intrus" }, headers: { origin: "https://evil.example" } });
  expect(evil.status()).toBe(403);

  // erreurs lisibles
  const bad = await page.request.post("/api/v1/properties", { data: { name: "x", city: "Paris", kind: "T2" } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toMatchObject({ code: "INVALID" });
  expect((await page.request.post("/api/v1/properties", { headers: { "content-type": "application/json" }, data: "[1]" })).status()).toBe(400);
  expect((await page.request.get("/api/v1/properties/inexistant")).status()).toBe(404);
  expect((await page.request.post("/api/v1/properties/inexistant/listings", { data: { channel: "DIRECT" } })).status()).toBe(404);

  // cycle complet par l'API
  const name = `API ${uid(info)}`;
  const id = await createViaApi(page, name, { bedrooms: 2, capacity: 4 });
  const list = await (await page.request.get("/api/v1/properties")).json();
  const mine = list.properties.find((p: any) => p.id === id);
  expect(mine).toMatchObject({ name, status: "ONBOARDING", bedrooms: 2, capacity: 4, isDemo: false });
  // jamais de clé ni de réglage interne dans la réponse
  expect(Object.keys(mine).sort()).toEqual(["bedrooms", "capacity", "city", "createdAt", "economicsVersion", "id", "isDemo", "kind", "name", "ownerId", "status", "strategyVersion"]);
  expect((await page.request.patch(`/api/v1/properties/${id}`, { data: { city: "Roubaix", capacity: null } })).status()).toBe(200);
  expect(await (await page.request.get(`/api/v1/properties/${id}`)).json()).toMatchObject({ city: "Roubaix", capacity: null });
  const l = await page.request.post(`/api/v1/properties/${id}/listings`, { data: { channel: "BOOKING", externalId: numeric(info) } });
  expect(l.status()).toBe(201);
  const lid = (await l.json()).id;
  expect((await page.request.patch(`/api/v1/properties/${id}/listings/${lid}`, { data: { channel: "AIRBNB" } })).status()).toBe(400);
  expect((await page.request.patch(`/api/v1/properties/${id}/listings/${lid}`, { data: { status: "ARCHIVED", title: "Booking" } })).status()).toBe(200);
  const listings = (await (await page.request.get(`/api/v1/properties/${id}/listings`)).json()).listings;
  expect(listings).toHaveLength(1);
  expect(listings[0]).toMatchObject({ status: "ARCHIVED", title: "Booking", channel: "BOOKING" });
  expect((await page.request.delete(`/api/v1/properties/${id}/listings/${lid}`)).status()).toBe(200);
  // suppression : nom exact obligatoire
  expect((await page.request.delete(`/api/v1/properties/${id}`, { data: { confirmName: "faux" } })).status()).toBe(400);
  expect((await page.request.delete(`/api/v1/properties/${id}`, { data: { confirmName: name } })).status()).toBe(200);
  expect((await page.request.get(`/api/v1/properties/${id}`)).status()).toBe(404);
});
