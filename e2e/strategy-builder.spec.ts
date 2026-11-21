import { Client } from "pg";
import { expect, test, type TestInfo } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-023 : Strategy Builder. Le logement est créé par l'API puis « lancé » en base (la création guidée est couverte ailleurs). Trois formats d'écran.
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test("Strategy Builder : brouillon sans effet, comparaison, publication, restauration, API", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Logement lancé en base : DATABASE_URL requis.");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.request.post("/api/v1/properties", { data: { name: `Builder ${uid(info)}`, city: "Lille", kind: "T2" } });
  const id = (await res.json()).id as string;
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try {
    const strategy = { basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 21000, minStay: 2, objective: "Objectif de départ", positioning: "Pro", maxDiscountStackPct: 20, maxPriceChangePct: 5 };
    const { rows: [pr] } = await c.query("select tenant_id from properties where id = $1", [id]);
    await c.query("update properties set status = 'ACTIVE', strategy = $2::jsonb, strategy_version = 1 where id = $1", [id, JSON.stringify(strategy)]);
    await c.query("insert into strategy_versions (id, tenant_id, property_id, version, strategy, changes, source, created_by) values ($1,$2,$3,1,$4::jsonb,'[]'::jsonb,'SYSTEM','system')", [`stv_e2e_${id}`, pr.tenant_id, id, JSON.stringify(strategy)]);
  } finally { await c.end(); }

  await page.goto(`/logements/${id}?tab=strategie`);
  await page.getByRole("link", { name: /Strategy Builder/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Strategy Builder" })).toBeVisible();
  await expect(page.getByTestId("strategy-status")).toContainText("version 1 en vigueur");
  await expectNoHorizontalOverflow(page, "/strategie");

  // une valeur hors bornes est refusée près du formulaire
  await page.locator("#sb-maxDiscountStackPct").fill("80");
  await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "de 0 à 50" })).toBeVisible();

  // brouillon : aucun effet tant qu'on ne publie pas
  await page.locator("#sb-maxDiscountStackPct").fill("15");
  await page.locator("#sb-minStay").fill("3");
  await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
  await expect(page.getByTestId("strategy-draft-diff")).toContainText("Cumul de remises maximal");
  await expect(page.getByTestId("strategy-draft-diff")).toContainText("2 nuits");
  await expect(page.getByTestId("strategy-status")).toContainText("brouillon en cours");
  expect((await (await page.request.get(`/api/v1/properties/${id}/strategy`)).json()).published.minStay).toBe(2);
  await expectNoHorizontalOverflow(page, "/strategie brouillon");

  // publication
  await page.locator("#sb-note").fill("Test e2e");
  await page.getByRole("button", { name: "Publier la stratégie" }).click();
  await expect(page.getByTestId("strategy-status")).toContainText("version 2 en vigueur");
  const cards = page.getByTestId("strategy-version");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Test e2e");
  await expect(cards.first()).toContainText("Strategy Builder");

  // restauration de la version 1 : nouvelle version 3, prix intacts
  const old = cards.nth(1);
  await old.locator("summary").click();
  await old.getByRole("button", { name: /Restaurer les réglages de cette version/ }).click();
  await expect(page.getByTestId("strategy-status")).toContainText("version 3 en vigueur");
  const api = await (await page.request.get(`/api/v1/properties/${id}/strategy`)).json();
  expect(api.version).toBe(3);
  expect(api.published).toMatchObject({ minStay: 2, maxDiscountStackPct: 20 });
  expect(api.prices).toEqual({ basePriceCents: 11600, minPriceCents: 8300, maxPriceCents: 21000 });
  expect(api.versions.map((v: any) => [v.version, v.source])).toEqual([[3, "ROLLBACK"], [2, "BUILDER"], [1, "SYSTEM"]]);
  await expectNoHorizontalOverflow(page, "/strategie après restauration");

  // API : brouillon puis publication, et conflit si la stratégie change entre-temps
  expect((await page.request.put(`/api/v1/properties/${id}/strategy`, { data: { maxPriceChangePct: 99 } })).status()).toBe(400);
  expect((await page.request.put(`/api/v1/properties/${id}/strategy`, { data: { maxPriceChangePct: 8 } })).status()).toBe(200);
  expect((await page.request.post(`/api/v1/properties/${id}/strategy/publish`, { data: { note: "via API" } })).status()).toBe(200);
  expect((await page.request.post(`/api/v1/properties/${id}/strategy/publish`, { data: {} })).status()).toBe(400); // plus de brouillon
  expect((await page.request.get(`/api/v1/properties/prop_inexistant/strategy`)).status()).toBe(404);
  expect(errors).toEqual([]);
});
