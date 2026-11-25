import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// Menu à deux niveaux (bureau), barre basse et feuille « Plus » (mobile), rangée et feuille filtrée (tablette).
const largeur = (page: Page) => page.viewportSize()!.width;

async function premierLogement(page: Page) {
  await page.goto("/logements");
  const hrefs = await page.locator('.content a[href^="/logements/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
  const href = hrefs.find((h) => /^\/logements\/[^/]+$/.test(h) && !h.endsWith("/nouveau"));
  expect(href).toBeTruthy();
  return href!;
}

test("Ordinateur : branches dépliables, branche courante ouverte, onglet reconnu, ouvertures mémorisées", async ({ page }, info) => {
  test.skip(largeur(page) < 1024, "colonne latérale : ordinateur seulement");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/portefeuille");
  const rail = page.locator(".rail");
  await expect(rail.getByRole("link", { name: "Tableau de bord" })).toHaveAttribute("aria-current", "page");
  const analyse = rail.getByRole("button", { name: "Analyse" });
  await expect(analyse).toHaveAttribute("aria-expanded", "false");
  await expect(rail.getByRole("link", { name: "Bilan mensuel" })).toBeHidden();
  // au clavier
  await analyse.focus(); await page.keyboard.press("Enter");
  await expect(analyse).toHaveAttribute("aria-expanded", "true");
  await expect(rail.getByRole("link", { name: "Bilan mensuel" })).toBeVisible();
  await page.reload();
  await expect(rail.getByRole("link", { name: "Bilan mensuel" })).toBeVisible();
  await rail.getByRole("button", { name: "Analyse" }).click();
  await expect(rail.getByRole("link", { name: "Bilan mensuel" })).toBeHidden();
  // la branche de l'écran courant s'ouvre seule
  await page.goto("/modeles");
  await expect(rail.getByRole("button", { name: "Paramètres" })).toHaveAttribute("aria-expanded", "true");
  await expect(rail.getByRole("link", { name: "Modèles" })).toHaveAttribute("aria-current", "page");

  await page.goto("/logements");
  await expect(rail.getByRole("link", { name: "Ajouter un logement" })).toBeVisible();
  const href = await premierLogement(page);
  await page.goto(`${href}?tab=canaux`);
  await expect(rail.getByRole("link", { name: "Stratégie & prix" })).toHaveAttribute("aria-current", "page");
  await expect(rail.locator('[aria-current="page"]')).toHaveCount(1);
  await rail.getByRole("link", { name: "Données & connexions" }).click();
  await expect(page).toHaveURL(/tab=superhote/);
  await expect(rail.getByRole("link", { name: "Données & connexions" })).toHaveAttribute("aria-current", "page");
  await rail.getByRole("link", { name: "Vue d'ensemble" }).click();
  await expect(rail.getByRole("link", { name: "Vue d'ensemble" })).toHaveAttribute("aria-current", "page");
  // sections visibles pour la branche ouverte seulement
  await expect(rail.locator(".rail-level-3:visible")).toHaveCount(6);
  await expectNoHorizontalOverflow(page, "menu ordinateur");
  await page.screenshot({ path: info.outputPath("menu-bureau.png") });
  await info.attach("menu-bureau", { path: info.outputPath("menu-bureau.png"), contentType: "image/png" });
  expect(errors).toEqual([]);
});

test("Mobile : cinq entrées en barre basse, feuille « Plus » en accordéon", async ({ page }, info) => {
  test.skip(largeur(page) >= 768, "barre basse : mobile seulement");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/portefeuille");
  const bar = page.getByRole("navigation", { name: "Navigation principale" });
  await expect(bar.locator(".bottombar-label")).toHaveText(["Accueil", "Opportunités", "Logements", "Alertes", "Plus"]);
  await expect(bar.getByRole("link", { name: /Accueil/ })).toHaveAttribute("aria-current", "page");
  const plus = bar.getByRole("button", { name: "Plus" });
  await plus.click();
  const sheet = page.getByRole("dialog", { name: "Tous les écrans" });
  await expect(sheet.locator("summary")).toHaveText(["Analyse", "Agence IA", "Paramètres"]);
  await expect(sheet.getByRole("link", { name: "Historique des décisions" })).toBeHidden();
  await sheet.locator("summary", { hasText: "Analyse" }).click();
  await expectNoHorizontalOverflow(page, "feuille Plus");
  await page.screenshot({ path: info.outputPath("feuille-plus.png") });
  await info.attach("feuille-plus", { path: info.outputPath("feuille-plus.png"), contentType: "image/png" });
  await sheet.getByRole("link", { name: "Historique des décisions" }).click();
  await expect(page).toHaveURL(/\/historique/);
  await expect(sheet).toBeHidden();
  await expect(plus).toHaveAttribute("aria-current", "true");
  // le groupe de l'écran courant est déplié à la réouverture
  await plus.click();
  await expect(sheet.getByRole("link", { name: "Historique des décisions" })).toBeVisible();
  await sheet.getByRole("button", { name: "Fermer" }).click();
  await expect(sheet).toBeHidden();
  const href = await premierLogement(page);
  await page.goto(href);
  await expect(bar.getByRole("link", { name: /Logements/ })).toHaveAttribute("aria-current", "true");
  expect(errors).toEqual([]);
});

test("Tablette : premier niveau en rangée, un groupe ouvre la feuille filtrée", async ({ page }, info) => {
  test.skip(info.project.name !== "bureau", "un seul passage suffit");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/portefeuille");
  const nav = page.locator(".navbar");
  await expect(nav.locator(".navbar-link")).toHaveCount(7);
  await expectNoHorizontalOverflow(page, "rangée tablette");
  await nav.getByRole("button", { name: "Agence IA" }).click();
  const sheet = page.getByRole("dialog", { name: "Agence IA" });
  await expect(sheet.locator("summary")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("feuille-tablette.png") });
  await info.attach("feuille-tablette", { path: info.outputPath("feuille-tablette.png"), contentType: "image/png" });
  await sheet.getByRole("link", { name: "Glossaire" }).click();
  await expect(page).toHaveURL(/\/glossaire/);
  await expect(sheet).toBeHidden();
  await expect(nav.getByRole("button", { name: "Agence IA" })).toHaveAttribute("aria-current", "true");
  // feuille restée ouverte quand l'écran s'élargit : elle se ferme au lieu de bloquer la page
  await nav.getByRole("button", { name: "Analyse" }).click();
  await expect(page.getByRole("dialog", { name: "Analyse" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".nav-sheet")).not.toHaveAttribute("open");
});
