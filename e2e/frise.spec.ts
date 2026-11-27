import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, friezeViolations } from "./helpers/layout";
import { versionComplete } from "./helpers/view";
import { deplierDossier } from "./helpers/dossier";

// Régression : sur mobile (390 px), les libellés de la frise du cycle (Observer, Diagnostiquer…) étaient très serrés et se chevauchaient.
test("frise du cycle d'un dossier : libellés lisibles, sans chevauchement", async ({ page }) => {
  await page.goto("/");
  const lien = page.locator('a[href^="/dossier/"]').first();
  await expect(lien, "aucun dossier trouvé sur l'accueil du compte de démo").toBeVisible();
  await lien.click();
  await deplierDossier(page);
  await expect(page.locator("ol.frieze")).toBeVisible();
  await expect(page.locator("ol.frieze > li")).toHaveCount(8);
  expect(await friezeViolations(page)).toEqual([]);
  await expectNoHorizontalOverflow(page, "dossier");
  await page.locator("#frise-h").scrollIntoViewIfNeeded();
  await page.locator("ol.frieze").screenshot({ path: test.info().outputPath("frise.png") });
  await test.info().attach("frise", { path: test.info().outputPath("frise.png"), contentType: "image/png" });
});

test("frise de la page Méthode : libellés lisibles, sans chevauchement", async ({ page }) => {
  await versionComplete(page.context()); // écran réservé à l'ordinateur
  await page.goto("/methode");
  await expect(page.locator("ol.frieze")).toBeVisible();
  expect(await friezeViolations(page)).toEqual([]);
});

// Paliers de la grille : 2 colonnes (< 640 px), 4 colonnes (≥ 640 px), 8 colonnes (≥ 1500 px). Aucun défilement horizontal, aucun texte coupé.
for (const [largeur, colonnes] of [[360, 2], [700, 4], [1280, 4], [1600, 8]] as const) {
  test(`frise de la page Méthode à ${largeur} px : ${colonnes} colonnes`, async ({ page }) => {
    await versionComplete(page.context()); // écran réservé à l'ordinateur
    await page.setViewportSize({ width: largeur, height: 900 });
    await page.goto("/methode");
    await expect(page.locator("ol.frieze")).toBeVisible();
    expect(await friezeViolations(page)).toEqual([]);
    const lefts = await page.locator("ol.frieze > li").evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))).size);
    expect(lefts, "nombre de colonnes de la frise").toBe(colonnes);
    const coupes = await page.locator("ol.frieze .fr-name").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.getClientRects().length > 1 && e.getBoundingClientRect().height > 24).length);
    expect(coupes, "libellés coupés ou sur plusieurs lignes").toBe(0);
    await expectNoHorizontalOverflow(page, `méthode ${largeur}px`);
  });
}
