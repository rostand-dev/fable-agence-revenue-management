import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { versionComplete } from "./helpers/view";
import { deplierDossier } from "./helpers/dossier";

// US-073 : seconde lecture indépendante de l'auditeur sur l'option retenue. Bureau, mobile 390 et 360 px (projets Playwright).
async function dossierRelu(page: Page): Promise<boolean> {
  await page.goto("/");
  const hrefs = await page.locator('a[href^="/dossier/"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));
  for (const h of hrefs) {
    await page.goto(h);
    await deplierDossier(page);
    if (await page.getByTestId("seconde-lecture").count()) return true;
  }
  return false;
}

test("Dossier : la seconde lecture de l'auditeur figure sur l'option retenue, sans débordement", async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!process.env.ANTHROPIC_API_BASE, "faux serveur de modèle absent : pas de seconde lecture");
  expect(await dossierRelu(page), "aucun dossier du compte de démo ne porte de seconde lecture").toBe(true);
  const bloc = page.getByTestId("seconde-lecture");
  await expect(bloc).toHaveCount(1);
  await expect(bloc).toBeVisible();
  await expect(bloc.locator(".state")).toHaveText(/^(aucune réserve|réserve)$/);
  // la seconde lecture est portée par l'option retenue
  await expect(page.locator("article.option", { has: page.locator(".tag", { hasText: "recommandée" }) }).getByTestId("seconde-lecture")).toHaveCount(1);
  await expectNoHorizontalOverflow(page, "dossier : seconde lecture");
  await bloc.scrollIntoViewIfNeeded();
  await bloc.screenshot({ path: test.info().outputPath("seconde-lecture.png") });
  await test.info().attach("seconde-lecture", { path: test.info().outputPath("seconde-lecture.png"), contentType: "image/png" });
});

test("Équipe : la fiche de l'auditeur annonce la seconde lecture et le veto déterministe", async ({ page }) => {
  await page.goto("/equipe/audit");
  await expect(page.getByText("Règles + raisonnement LLM").first()).toBeVisible();
  await expect(page.getByText(/ne peut qu.ajouter une alerte|peut seulement ajouter une alerte/).first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "équipe : auditeur");
});

test("Méthode : la répartition règles / modèle mentionne la seconde lecture", async ({ page }) => {
  await versionComplete(page.context()); // écran réservé à l'ordinateur
  await page.goto("/methode");
  await expect(page.getByText("seconde lecture de l'auditeur")).toBeVisible();
  await expect(page.getByText("INDEPENDENT_REVIEW").first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "méthode");
});
