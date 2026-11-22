import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-060 : le catalogue des playbooks (page Méthode) et les mesures du signal (dossier d'opportunité). Bureau, mobile 390 et 360 px.
test("Méthode : le catalogue des 13 playbooks se déplie, avec seuils, données, repos et approbation", async ({ page }) => {
  await page.goto("/methode");
  const section = page.getByTestId("playbooks");
  await expect(section).toBeVisible();
  await expect(section.locator("li.playbook")).toHaveCount(13);
  const pb01 = section.locator("li.playbook").first();
  await expect(pb01).toContainText("PB-01");
  await pb01.locator("summary").click();
  await expect(pb01.getByRole("table")).toBeVisible();
  await expect(pb01).toContainText("Écart d'occupation au marché");
  await expect(pb01).toContainText("−18 pts");
  await expect(pb01).toContainText("Période de repos après décision");
  await expect(pb01).toContainText("14 jours");
  // un playbook décrit au blueprint mais pas encore codé le dit
  await expect(section.locator("li.playbook", { hasText: "PB-08" })).toContainText("pas encore actif");
  await expect(section.locator("li.playbook", { hasText: "PB-04" })).not.toContainText("pas encore actif");
  await expectNoHorizontalOverflow(page, "méthode : playbooks");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: test.info().outputPath("playbooks.png") });
  await test.info().attach("playbooks", { path: test.info().outputPath("playbooks.png"), contentType: "image/png" });
});

test("Dossier : le signal affiche ses mesures face à leur seuil, sans débordement", async ({ page }) => {
  await page.goto("/");
  const lien = page.locator('a[href^="/dossier/"]').first();
  await expect(lien, "aucun dossier trouvé sur l'accueil du compte de démo").toBeVisible();
  await lien.click();
  const card = page.getByTestId("signal-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("table")).toBeVisible();
  await expect(card.getByRole("columnheader")).toHaveText(["Mesure", "Observé", "Seuil"]);
  expect(await card.locator("tbody tr").count()).toBeGreaterThan(0);
  await expect(card).toContainText(/PB-\d\d/);
  await expectNoHorizontalOverflow(page, "dossier : signal");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: test.info().outputPath("signal.png") });
  await test.info().attach("signal", { path: test.info().outputPath("signal.png"), contentType: "image/png" });
});
