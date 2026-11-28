import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { httpCredentials } from "./helpers/env";
import { VERSION_COMPLETE } from "./helpers/view";

// journal et filtres : en mode poche, ils sont derrière « Version complète »
test.use(VERSION_COMPLETE);

// US-085 : le journal d'audit se filtre par période et par auteur, en plus de la famille. Bureau, 390 et 360 px.
test("Journal : filtres période et auteur visibles, sans débordement", async ({ page }) => {
  await page.goto("/historique#journal");
  const f = page.getByTestId("journal-filtres");
  await expect(f).toBeVisible();
  for (const l of ["Du", "Au"]) await expect(f.getByLabel(l, { exact: true })).toBeVisible();
  await expect(f.getByRole("combobox", { name: /Auteur/ })).toBeVisible();
  await expect(page.getByTestId("journal-reinit")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "journal filtres");
  await f.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("journal-filtres.png") });
  await test.info().attach("journal-filtres", { path: test.info().outputPath("journal-filtres.png"), contentType: "image/png" });
});

test("Période dans le passé lointain : état vide explicite ; réinitialiser rétablit le journal", async ({ page }) => {
  await page.goto("/historique#journal");
  const avant = await page.locator("#journal ul.timeline > li").count();
  expect(avant, "la démonstration doit avoir des événements au journal").toBeGreaterThan(0);
  await page.getByTestId("journal-filtres").getByLabel("Du", { exact: true }).fill("2000-01-01");
  await page.getByTestId("journal-filtres").getByLabel("Au", { exact: true }).fill("2000-01-31");
  await page.getByRole("button", { name: "Appliquer" }).click();
  await expect(page).toHaveURL(/de=2000-01-01&au=2000-01-31|au=2000-01-31&de=2000-01-01/);
  await expect(page.getByRole("heading", { name: "Aucun événement" })).toBeVisible();
  await expect(page.getByText("Ce n'est pas une confirmation que rien ne s'est passé")).toBeVisible();
  await expectNoHorizontalOverflow(page, "journal période vide");
  await page.getByTestId("journal-reinit").click();
  // les autres tests (3 formats d'écran en parallèle) inscrivent des événements au même journal : le total ne peut que croître
  await expect.poll(() => page.locator("#journal ul.timeline > li").count()).toBeGreaterThanOrEqual(avant);
});

test("Auteur « Le système » : seuls des événements non humains ; dates inversées ou invalides tolérées", async ({ page }) => {
  await page.goto("/historique?qui=system#journal");
  await expect(page.getByTestId("journal-filtres").getByLabel("Auteur")).toHaveValue("system");
  const whos = await page.locator("#journal ul.timeline .tl-who").allTextContents();
  expect(whos.length, "au moins un événement système attendu").toBeGreaterThan(0);
  for (const w of whos) { expect(w).not.toBe("Vous"); }
  const r = await page.goto("/historique?de=2030-12-31&au=2000-01-01&qui=zz#journal");
  expect(r?.status()).toBe(200);
  await expect(page.getByTestId("journal-filtres").getByLabel("Auteur")).toHaveValue("");
  await expect(page.getByTestId("journal-filtres").getByLabel("Du", { exact: true })).toHaveValue("2000-01-01"); // inversées : remises dans l'ordre
  await expectNoHorizontalOverflow(page, "journal dates inversées");
});

test("API du journal : paramètres validés (400), filtres positifs, session requise (401)", async ({ request, browser, baseURL }) => {
  expect((await request.get("/api/audit-events?from=2026-02-31")).status()).toBe(400);
  expect((await request.get("/api/audit-events?from=2026-03-10&to=2026-03-01")).status()).toBe(400);
  expect((await request.get("/api/audit-events?actor=root")).status()).toBe(400);
  const ok = await request.get("/api/audit-events?from=2000-01-01&to=2000-01-02&actor=human");
  expect(ok.status()).toBe(200);
  expect((await ok.json()).events).toEqual([]);
  const jour = new Date().toISOString().slice(0, 10);
  const auj = await (await request.get(`/api/audit-events?from=${jour}&to=${jour}`)).json();
  const hum = await (await request.get("/api/audit-events?actor=human&limit=50")).json();
  for (const e of hum.events) expect(e.actor.startsWith("user:")).toBe(true);
  for (const e of auj.events) expect(e.at.slice(0, 10)).toBe(jour);
  const anon = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  expect((await anon.request.get("/api/audit-events")).status()).toBe(401);
  await anon.close();
});
