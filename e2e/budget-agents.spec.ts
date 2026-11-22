import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-074 : l'onglet « Activité » d'une fiche agent affiche le budget de jetons du jour et la trace de chaque intervention. Bureau, mobile 390 et 360 px.
test("Fiche agent, onglet Activité : budget de jetons du jour et historique lisibles, sans débordement", async ({ page }) => {
  await page.goto("/equipe/direction?tab=activite");
  await expect(page.getByText("Budget de jetons du jour (tous agents)")).toBeVisible();
  await expect(page.getByText(/sur 300\s?000/).or(page.getByText("appels de modèle désactivés"))).toBeVisible();
  await expect(page.locator("ul.timeline li").first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "fiche agent : activité");
  await page.screenshot({ path: test.info().outputPath("activite.png"), fullPage: false });
  await test.info().attach("activite", { path: test.info().outputPath("activite.png"), contentType: "image/png" });
});

test("Fiche de chaque agent : l'onglet Activité s'ouvre sans erreur", async ({ page }) => {
  for (const id of ["direction", "onboarding", "marche", "pricing", "distribution", "annonce", "audit", "reporting"]) {
    const res = await page.goto(`/equipe/${id}?tab=activite`);
    expect(res?.status(), id).toBe(200);
    await expect(page.getByText("Interventions récentes"), id).toBeVisible();
    await expectNoHorizontalOverflow(page, `activité ${id}`);
  }
});
