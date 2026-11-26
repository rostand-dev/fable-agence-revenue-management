import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";

// écrans réservés à l'ordinateur : testés en version complète à toutes les largeurs
test.use(VERSION_COMPLETE);

// US-062 : écran de réglage de la priorisation et explication du rang dans le dossier. Bureau, mobile 390 et 360 px. Rien n'est enregistré (compte de démo partagé).
test("Priorisation : la page est lisible, avec ses bornes, sans débordement", async ({ page }) => {
  await page.goto("/parametres/priorisation");
  const s = page.getByTestId("priorisation");
  await expect(s).toBeVisible();
  await expect(s).toContainText("ne contourne jamais un veto");
  await expect(s.locator('input[name="w-PB-01"]')).toHaveValue("1");
  await expect(s.locator('input[name="r-MEDIUM"]')).toHaveValue("4");
  await expect(s.locator('input[name="c-MANUAL_RUNBOOK"]')).toHaveValue("0");
  await expect(s.getByRole("button", { name: "Rétablir les valeurs par défaut" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "priorisation");
  await s.scrollIntoViewIfNeeded();
  await s.screenshot({ path: test.info().outputPath("priorisation.png") });
  await test.info().attach("priorisation", { path: test.info().outputPath("priorisation.png"), contentType: "image/png" });
});

test("Priorisation : une valeur hors bornes est refusée avec le champ nommé", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/parametres/priorisation");
  const s = page.getByTestId("priorisation");
  await s.locator('input[name="w-PB-01"]').evaluate((el: HTMLInputElement) => { el.removeAttribute("max"); });
  await s.locator('input[name="w-PB-01"]').fill("9");
  await s.getByRole("button", { name: "Enregistrer la priorisation" }).click();
  await expect(s).toContainText("Poids de PB-01");
  await expect(s.getByRole("alert")).toHaveCount(1);
  // aucun champ du formulaire ne doit masquer une méthode native (reset) : sinon erreur après chaque envoi
  expect(await s.locator("form").first().evaluate((f: HTMLFormElement) => typeof f.reset)).toBe("function");
  expect(errors, "erreurs JavaScript").toEqual([]);
  await page.reload();
  await expect(page.getByTestId("priorisation").locator('input[name="w-PB-01"]')).toHaveValue("1"); // rien n'a été enregistré
});

test("Priorisation : « Rétablir » remet les champs aux valeurs enregistrées, sans rien écrire quand elles sont par défaut", async ({ page }) => {
  await page.goto("/parametres/priorisation");
  const s = page.getByTestId("priorisation"), poids = s.locator('input[name="w-PB-01"]');
  await poids.fill("3");
  await s.getByRole("button", { name: "Rétablir les valeurs par défaut" }).click();
  await expect(s.getByRole("status")).toContainText("Aucun changement");
  await expect(poids).toHaveValue("1");
});

test("Dossier : « Pourquoi cette priorité » décompose le score", async ({ page }) => {
  await page.goto("/");
  await page.locator('a[href^="/dossier/"]').first().click();
  const card = page.getByTestId("rang-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("row")).not.toHaveCount(0);
  await expect(card).toContainText("Gain net attendu");
  await expect(card).toContainText("Pénalité de risque");
  await expectNoHorizontalOverflow(page, "dossier : rang");
});
