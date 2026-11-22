import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-061 : un dossier tranché affiche sa période de repos ; les dossiers liés (nuits qui se touchent) s'affichent sans débordement.
test("Dossier tranché : la période de repos du playbook est expliquée, sans débordement", async ({ page }) => {
  await page.goto("/historique");
  const hrefs = await page.locator('a[href^="/dossier/"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));
  expect(hrefs.length, "aucun dossier dans l'historique de démonstration").toBeGreaterThan(0);
  let found = false;
  for (const href of hrefs.slice(0, 12)) {
    await page.goto(href);
    const repos = page.getByTestId("repos");
    if (await repos.count()) {
      await expect(repos).toContainText("ne rouvre pas de dossier jusqu'au");
      await expect(repos).toContainText("jours de repos");
      await expectNoHorizontalOverflow(page, "dossier tranché : repos");
      await repos.scrollIntoViewIfNeeded();
      await page.getByTestId("dossiers-lies").screenshot({ path: test.info().outputPath("repos.png") });
      await test.info().attach("repos", { path: test.info().outputPath("repos.png"), contentType: "image/png" });
      found = true;
      break;
    }
  }
  expect(found, "aucun dossier tranché avec une période de repos").toBe(true);
});

test("Dossier ouvert : s'affiche sans débordement, avec ses dossiers liés lorsqu'il en a", async ({ page }) => {
  await page.goto("/");
  const hrefs = await page.locator('a[href^="/dossier/"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));
  expect(hrefs.length).toBeGreaterThan(0);
  for (const href of hrefs.slice(0, 6)) {
    await page.goto(href);
    await expect(page.getByTestId("signal-card")).toBeVisible();
    const lies = page.getByTestId("dossiers-lies");
    if (await lies.count()) await expect(lies.locator("li a").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "dossier ouvert " + href);
  }
});
