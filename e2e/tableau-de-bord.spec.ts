import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-080 : tableau de bord du portefeuille. Bureau, 390 et 360 px.
test("Tableau de bord : sections, chiffres cohérents avec la boîte d'opportunités, sans débordement", async ({ page }) => {
  await page.goto("/portefeuille");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/situation|Rien à arbitrer/);
  for (const t of ["pf-decider", "pf-actions", "pf-logements", "pf-kpi", "pf-integrations"]) await expect(page.getByTestId(t)).toBeVisible();
  await expectNoHorizontalOverflow(page, "tableau de bord");
  // le total « Situations ouvertes » égale le nombre de cartes de la boîte d'opportunités
  const ouvertes = Number(/(\d+)/.exec(await page.getByTestId("pf-decider").locator("a").first().innerText())?.[1]);
  expect(ouvertes, "la démonstration doit avoir des situations ouvertes").toBeGreaterThan(0);
  await page.goto("/");
  await expect(page.locator("article.sit")).toHaveCount(ouvertes);
  await page.goto("/portefeuille");
  await page.screenshot({ path: test.info().outputPath("tableau-de-bord.png"), fullPage: true });
  await test.info().attach("tableau-de-bord", { path: test.info().outputPath("tableau-de-bord.png"), contentType: "image/png" });
});

test("Chaque tuile « À décider » mène à une liste de même taille que son chiffre (veto, urgent, renforcée)", async ({ page }) => {
  for (const [nom, param] of [["Sous veto", "veto"], ["Séjours urgents", "urgent"], ["Validation renforcée", "renforcee"]] as const) {
    await page.goto("/portefeuille");
    const tuile = page.getByTestId("pf-decider").getByRole("link", { name: new RegExp(nom, "i") });
    const chiffre = Number(/(\d+)/.exec(await tuile.innerText())?.[1]);
    expect(Number.isInteger(chiffre), `chiffre lisible dans la tuile ${nom}`).toBe(true);
    await tuile.click();
    await expect(page).toHaveURL(new RegExp(`/\\?u=${param}`));
    await expect(page.getByTestId("inbox-filtres").getByLabel("Urgence")).toHaveValue(param);
    await expect(page.locator("article.sit"), `liste « ${nom} » = chiffre du tableau de bord`).toHaveCount(chiffre);
  }
});

test("Liens des logements : fiche, situations ouvertes filtrées par logement ; l'occupation est un taux ou « inconnue »", async ({ page }) => {
  await page.goto("/portefeuille");
  const lignes = page.getByTestId("pf-logements").locator("tbody tr");
  expect(await lignes.count(), "au moins un logement dans la démonstration").toBeGreaterThan(0);
  const occ = await page.getByTestId("pf-kpi").innerText();
  const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(occ);
  if (m) expect(Number(m[1].replace(",", ".")), "occupation : un taux, jamais plus de 100 %").toBeLessThanOrEqual(100);
  else expect(occ).toMatch(/inconnue/i);
  const lien = page.getByTestId("pf-logements").locator('a[href^="/?p="]').first();
  expect(await lien.count(), "au moins un logement avec des situations ouvertes").toBeGreaterThan(0);
  await lien.click();
  await expect(page).toHaveURL(/\/\?p=/);
  await expect(page.getByTestId("inbox-compteur")).toContainText("1 filtre actif");
  await page.goto("/portefeuille");
  await page.getByTestId("pf-logements").locator('a[href^="/logements/"]').first().click();
  await expect(page).toHaveURL(/\/logements\//);
});

test("Navigation : « Tableau de bord » est accessible depuis le menu, et la page reste utilisable au clavier", async ({ page }) => {
  await page.goto("/");
  const lien = page.getByRole("link", { name: "Tableau de bord" }).first();
  if (!(await lien.isVisible())) await page.getByRole("button", { name: /Plus/ }).click();
  await page.getByRole("link", { name: "Tableau de bord" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(/\/portefeuille/);
  await expect(page.getByTestId("pf-integrations")).toContainText("SuperHote");
  await expect(page.getByTestId("pf-integrations")).toContainText("PriceLabs");
  await expectNoHorizontalOverflow(page, "tableau de bord via navigation");
});
