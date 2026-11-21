import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, friezeViolations } from "./helpers/layout";

// Régression : sur mobile (390 px), les libellés de la frise du cycle (Observer, Diagnostiquer…) étaient très serrés et se chevauchaient.
test("frise du cycle d'un dossier : libellés lisibles, sans chevauchement", async ({ page }) => {
  // BUG CONNU (démontré par ce test) : les colonnes de la frise (grid minmax(0, 1fr)) sont plus étroites que la largeur minimale (min-width) des cases, donc les étapes se chevauchent.
  // Échec attendu : la CI reste verte tant que le bug existe. La PR de correction DOIT retirer cette ligne (sinon ce test échoue, car il passerait).
  test.fail(true, "chevauchement connu de la frise du cycle, à corriger dans une PR dédiée");
  await page.goto("/");
  const lien = page.locator('a[href^="/dossier/"]').first();
  await expect(lien, "aucun dossier trouvé sur l'accueil du compte de démo").toBeVisible();
  await lien.click();
  await expect(page.locator("ol.frieze")).toBeVisible();
  await expect(page.locator("ol.frieze > li")).toHaveCount(8);
  expect(await friezeViolations(page)).toEqual([]);
  await expectNoHorizontalOverflow(page, "dossier");
  await page.locator("#frise-h").scrollIntoViewIfNeeded();
  await page.locator("ol.frieze").screenshot({ path: test.info().outputPath("frise.png") });
  await test.info().attach("frise", { path: test.info().outputPath("frise.png"), contentType: "image/png" });
});

test("frise de la page Méthode : libellés lisibles, sans chevauchement", async ({ page }) => {
  // BUG CONNU (démontré par ce test) : les colonnes de la frise (grid minmax(0, 1fr)) sont plus étroites que la largeur minimale (min-width) des cases, donc les étapes se chevauchent.
  // Échec attendu : la CI reste verte tant que le bug existe. La PR de correction DOIT retirer cette ligne (sinon ce test échoue, car il passerait).
  test.fail(true, "chevauchement connu de la frise du cycle, à corriger dans une PR dédiée");
  await page.goto("/methode");
  await expect(page.locator("ol.frieze")).toBeVisible();
  expect(await friezeViolations(page)).toEqual([]);
});
