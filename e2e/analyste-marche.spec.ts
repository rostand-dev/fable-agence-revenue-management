import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-071 : l'analyse de marché d'un dossier (constats qui renvoient à des preuves numérotées). Bureau, mobile 390 et 360 px.
async function firstDossier(page: Page): Promise<string> {
  await page.goto("/");
  const hrefs = await page.locator('a[href^="/dossier/"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));
  expect(hrefs.length, "aucun dossier sur l'accueil du compte de démo").toBeGreaterThan(0);
  return hrefs[0];
}

test("Dossier : l'analyse du marché cite des preuves numérotées qui existent dans le volet de preuves", async ({ page }) => {
  await page.goto(await firstDossier(page));
  const analyse = page.getByTestId("analyse-marche");
  await expect(analyse).toBeVisible();
  await expect(analyse).toContainText("Analyse du marché");
  const constats = analyse.getByTestId("constat");
  expect(await constats.count()).toBeGreaterThan(0);
  const renvois = analyse.getByTestId("renvoi-preuve");
  expect(await renvois.count()).toBeGreaterThan(0);
  // chaque renvoi (E1…) pointe vers une pièce réellement présente
  for (const r of await renvois.all()) {
    const id = (await r.textContent())!.trim();
    await expect(page.locator(`#preuve-${id}`), `la preuve ${id} citée n'existe pas`).toHaveCount(1);
  }
  await expect(page.getByTestId("numero-preuve").first()).toHaveText(/^E\d+$/);
  await expectNoHorizontalOverflow(page, "dossier : analyse du marché");
  await analyse.scrollIntoViewIfNeeded();
  await analyse.screenshot({ path: test.info().outputPath("analyse.png") });
  await test.info().attach("analyse", { path: test.info().outputPath("analyse.png"), contentType: "image/png" });
});

test("Dossier : un renvoi de preuve mène à la pièce citée", async ({ page }) => {
  await page.goto(await firstDossier(page));
  const lien = page.getByTestId("analyse-marche").getByTestId("renvoi-preuve").first();
  const id = (await lien.textContent())!.trim();
  await lien.click();
  await expect(page).toHaveURL(new RegExp(`#preuve-${id}$`));
  await expect(page.locator(`#preuve-${id}`)).toBeVisible();
});

// Une seule largeur lance la revue (les projets s'exécutent en parallèle sur le même compte) ; le faux serveur de modèle répond sans clé réelle.
test("Revue avec modèle : les constats sont rédigés par l'analyste (faux serveur de modèle)", async ({ page }, info) => {
  test.skip(info.project.name !== "bureau", "revue lancée une seule fois, sur la largeur bureau");
  test.skip(!process.env.ANTHROPIC_API_BASE, "faux serveur de modèle absent");
  await page.goto("/");
  await page.getByRole("button", { name: "Relancer la revue" }).click();
  await expect(page.getByText("Revue terminée.")).toBeVisible({ timeout: 30_000 });
  await page.goto(await firstDossier(page));
  const analyse = page.getByTestId("analyse-marche");
  await expect(analyse).toContainText("a rédigé ces constats à partir des pièces numérotées");
  await expect(analyse.getByTestId("constat").first()).toContainText("Les pièces citées décrivent");
  await page.goto("/equipe/marche?tab=activite");
  await expect(page.getByTestId("trace-prompt").first()).toContainText("marche.market_analysis");
});
