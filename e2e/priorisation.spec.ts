import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-062 : écran de réglage de la priorisation et explication du rang dans le dossier. Bureau, mobile 390 et 360 px. Les réglages ne sont pas modifiés (compte de démo partagé).
test("Réglages : la priorisation est lisible, avec ses bornes, sans débordement", async ({ page }) => {
  await page.goto("/reglages");
  const s = page.getByTestId("priorisation");
  await expect(s).toBeVisible();
  await expect(s).toContainText("ne contourne jamais un veto");
  await expect(s.locator('input[name="w-PB-01"]')).toHaveValue("1");
  await expect(s.locator('input[name="r-MEDIUM"]')).toHaveValue("4");
  await expect(s.locator('input[name="c-MANUAL_RUNBOOK"]')).toHaveValue("0");
  await expect(s.getByRole("button", { name: "Rétablir les valeurs par défaut" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "réglages : priorisation");
  await s.scrollIntoViewIfNeeded();
  await s.screenshot({ path: test.info().outputPath("priorisation.png") });
  await test.info().attach("priorisation", { path: test.info().outputPath("priorisation.png"), contentType: "image/png" });
});

test("Réglages : une valeur hors bornes est refusée avec le champ nommé", async ({ page }) => {
  await page.goto("/reglages");
  const s = page.getByTestId("priorisation");
  await s.locator('input[name="w-PB-01"]').evaluate((el: HTMLInputElement) => { el.removeAttribute("max"); });
  await s.locator('input[name="w-PB-01"]').fill("9");
  await s.getByRole("button", { name: "Enregistrer la priorisation" }).click();
  await expect(s).toContainText("Poids de PB-01");
  await s.getByRole("button", { name: "Rétablir les valeurs par défaut" }).waitFor();
});

test("Dossier : « Pourquoi ce rang » décompose le score", async ({ page }) => {
  await page.goto("/");
  await page.locator('a[href^="/dossier/"]').first().click();
  const card = page.getByTestId("rang-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("row")).not.toHaveCount(0);
  await expect(card).toContainText("Gain net attendu");
  await expect(card).toContainText("Pénalité de risque");
  await expectNoHorizontalOverflow(page, "dossier : rang");
});
