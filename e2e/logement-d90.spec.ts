import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { httpCredentials } from "./helpers/env";
import { createRoleUser, deleteUser, hasDatabase, seedPropertyEvent } from "./helpers/roles";

// US-081 : espace logement à 90 jours : synthèse de l'horizon et chronologie du logement. Bureau, 390 et 360 px.
async function premierLogement(page: Page): Promise<string> {
  await page.goto("/logements");
  const hrefs = await page.locator('.content a[href^="/logements/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!).filter((h) => /^\/logements\/[^/]+$/.test(h) && !h.endsWith("/nouveau")));
  expect(hrefs.length, "aucun logement dans la démonstration").toBeGreaterThan(0);
  return hrefs[0];
}

test("90 jours : la synthèse de l'horizon est lisible et cohérente, sans débordement", async ({ page }) => {
  const href = await premierLogement(page);
  await page.goto(`${href}?tab=calendrier`);
  const s = page.getByTestId("horizon-synthese");
  await expect(s).toBeVisible();
  for (const l of ["Nuits réservées", "Nuits libres", "Occupation des nuits vendables", "Nuits touchées par un dossier"]) await expect(s).toContainText(l);
  // cohérence : réservées + libres + bloquées = nuits lues du calendrier
  const nuits = await page.locator(".cal > a, .cal > .cal-day").count();
  const lu = Number(/sur (\d+) nuits lues/i.exec(await s.innerText())?.[1]);
  expect(lu).toBe(nuits);
  const txt = await s.innerText();
  const reservees = Number(/Nuits réservées\s*(\d+)/i.exec(txt)?.[1]), libres = Number(/Nuits libres\s*(\d+)/i.exec(txt)?.[1]), bloquees = Number(/(\d+) nuits? bloquée/i.exec(txt)?.[1] ?? 0);
  expect(reservees + libres + bloquees, "réservées + libres + bloquées = nuits lues").toBe(lu);
  await expectNoHorizontalOverflow(page, "90 jours");
  await s.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("d90.png") });
  await test.info().attach("d90", { path: test.info().outputPath("d90.png"), contentType: "image/png" });
});

test("Onglet Historique : chronologie du logement, liens vers les dossiers, sans débordement", async ({ page }) => {
  const href = await premierLogement(page);
  await page.goto(`${href}?tab=historique`);
  const h = page.getByTestId("historique-logement");
  await expect(h.getByRole("heading", { name: "Chronologie du logement" })).toBeVisible();
  // la section courante est montrée par la colonne (grand écran) ou par le bouton « Section » (mobile, tablette)
  if ((page.viewportSize()?.width ?? 1280) >= 1024) await expect(page.locator(".rail").getByRole("link", { name: "Historique", exact: true }).and(page.locator('[aria-current="page"]'))).toBeVisible();
  else await expect(page.locator(".section-switcher-btn")).toContainText("Section : Historique");
  if (await page.locator("ul.timeline > li").count() === 0) await expect(h).toContainText("Aucun événement");
  await expectNoHorizontalOverflow(page, "historique logement");
  await h.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("historique-logement.png") });
  await test.info().attach("historique-logement", { path: test.info().outputPath("historique-logement.png"), contentType: "image/png" });
});

test("Onglet Historique : refusé sans droit de lecture du journal (Analyste)", async ({ page, browser, baseURL }) => {
  test.skip(!hasDatabase(), "DATABASE_URL absent : comptes de rôles non créables sur cet environnement");
  const href = await premierLogement(page);
  const tag = test.info().project.name.replace(/\W/g, "") + "-" + test.info().parallelIndex + "-" + Date.now().toString(36);
  const u = await createRoleUser("ANALYST", tag);
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  try {
    const p = await ctx.newPage();
    await p.goto("/connexion");
    await p.getByLabel("Adresse e-mail").fill(u.email);
    await p.getByLabel("Mot de passe").fill(u.password);
    await p.getByRole("button", { name: "Se connecter" }).click();
    await p.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 15_000 });
    await p.goto(`${href}?tab=historique`);
    const h = p.getByTestId("historique-logement");
    await expect(h).toContainText("Chronologie réservée");
    await expect(h).toContainText("Analyste");
    await expect(h.locator("ul.timeline")).toHaveCount(0);
    await expectNoHorizontalOverflow(p, "historique logement refusé");
  } finally { await ctx.close(); await deleteUser(u.id); }
});

test("Onglet Historique rempli : un événement inscrit au journal apparaît, le plus récent en premier", async ({ page }) => {
  test.skip(!hasDatabase(), "DATABASE_URL absent : impossible d'inscrire un événement de test");
  const href = await premierLogement(page);
  const id = href.split("/").pop()!;
  const marque = "Événement E2E " + test.info().project.name + " " + Date.now().toString(36);
  await seedPropertyEvent(id, marque);
  await page.goto(`${href}?tab=historique`);
  const h = page.getByTestId("historique-logement");
  const premier = h.locator("ul.timeline > li").first();
  await expect(premier).toContainText(marque);
  await expect(premier.locator(".tl-when")).toContainText("Logement modifié");
  await expectNoHorizontalOverflow(page, "historique logement rempli");
});
