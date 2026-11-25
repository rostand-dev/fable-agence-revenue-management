import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// Paramètres regroupés (une page par sujet), redirection des anciens Réglages et sommaire de la Méthode. Trois formats d'écran ; aucune écriture.
// [carte, adresse, titre de la page ouverte]
const PAGES = [
  ["compte", "/parametres/compte", "Compte & sécurité"], ["proprietaires", "/proprietaires", "Propriétaires"], ["integrations", "/integrations", "Ce que l'agence peut lire et écrire"],
  ["modeles", "/modeles", "Modèles de langage"], ["priorisation", "/parametres/priorisation", "Priorisation des dossiers"], ["demo", "/parametres/demo", "Démonstration"],
] as const;

test("Paramètres : six cartes avec leur origine, chacune ouvre sa page, rattachée aux Paramètres", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/parametres");
  const hub = page.getByRole("list", { name: "Rubriques des paramètres" });
  await expect(hub.getByRole("link")).toHaveCount(6);
  await expect(hub.locator(".hub-card-foot", { hasText: "Vient de :" })).toHaveCount(6);
  await expectNoHorizontalOverflow(page, "/parametres");
  await page.screenshot({ path: info.outputPath("parametres.png"), fullPage: true });
  await info.attach("parametres", { path: info.outputPath("parametres.png"), contentType: "image/png" });
  for (const [carte, path, titre] of PAGES) {
    await page.goto("/parametres");
    await page.getByTestId(`hub-card-${carte}`).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator("h1").first(), path).toHaveText(titre);
    // le fil d'Ariane est masqué sur mobile (la feuille « Plus » ramène aux Paramètres)
    if (page.viewportSize()!.width >= 768) await expect(page.getByRole("navigation", { name: "Fil d'Ariane" }).getByRole("link", { name: "Paramètres" })).toBeVisible();
    await expectNoHorizontalOverflow(page, path);
    await page.screenshot({ path: info.outputPath(`${path.replace(/\//g, "-")}.png`) });
  }
  // rien n'est perdu : les rubriques de l'ancien écran sont réparties
  await page.goto("/parametres/compte");
  for (const t of ["Compte", "Vos droits", "Fonctions activées", "Sécurité", "Équipe IA"]) await expect(page.getByRole("heading", { level: 2, name: t, exact: true })).toBeVisible();
  for (const t of ["Prénoms de l'équipe", "Modèles par agent"]) await expect(page.getByRole("heading", { level: 3, name: t })).toBeVisible();
  await page.goto("/parametres/demo");
  await expect(page.getByRole("button", { name: /Réinstaller la démonstration/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Anciens Réglages : redirection 308, les ancres mènent à la bonne page", async ({ page }) => {
  const res = await page.request.get("/reglages", { maxRedirects: 0 });
  expect(res.status()).toBe(308);
  expect(res.headers()["location"]).toMatch(/\/parametres$/);
  await page.goto("/reglages");
  await expect(page).toHaveURL(/\/parametres$/);
  for (const [ancre, cible] of [["droits", "compte"], ["fonctions", "compte"], ["securite", "compte"], ["equipe-ia", "compte"], ["modeles-agents", "compte"], ["priorisation", "priorisation"]]) {
    await page.goto(`/reglages#${ancre}`);
    await expect(page).toHaveURL(new RegExp(`/parametres/${cible}#${ancre}$`));
    await expect(page.locator(`#${ancre}`)).toBeInViewport();
  }
  await page.goto("/reglages#inconnue");
  await page.waitForLoadState("networkidle"); // laisse au renvoi d'ancre le temps d'agir s'il agissait à tort
  await expect(page.getByRole("heading", { level: 1, name: "Paramètres" })).toBeVisible();
  await expect(page).toHaveURL(/\/parametres#inconnue$/);
});

test("Mobile : la feuille « Plus » mène à l'accueil des Paramètres", async ({ page }) => {
  test.skip(page.viewportSize()!.width >= 768, "barre basse : mobile seulement");
  await page.goto("/portefeuille");
  const plus = page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: "Plus" });
  const sheet = page.getByRole("dialog", { name: "Tous les écrans" });
  // un appui avant l'hydratation est sans effet : on recommence tant que la feuille est fermée
  await expect(async () => { if (!(await sheet.isVisible())) await plus.click(); await expect(sheet).toBeVisible({ timeout: 1000 }); }).toPass();
  await sheet.locator("summary", { hasText: "Paramètres" }).click();
  await sheet.getByRole("link", { name: "Tous les paramètres" }).click();
  await expect(page).toHaveURL(/\/parametres$/);
  await expect(plus).toHaveAttribute("aria-current", "true");
});

test("Méthode : le sommaire mène à chaque section", async ({ page }, info) => {
  await page.goto("/methode");
  const toc = page.getByRole("navigation", { name: "Sommaire" });
  const anchors = await toc.getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
  expect(anchors.length).toBeGreaterThanOrEqual(9);
  // chaque entrée vise une section existante, et aucune section n'est oubliée
  for (const a of anchors) await expect(page.locator(a), a).toHaveCount(1);
  await expect(page.locator(".content section.section")).toHaveCount(anchors.length);
  await expectNoHorizontalOverflow(page, "/methode sommaire");
  await page.screenshot({ path: info.outputPath("methode.png") });
  await info.attach("methode", { path: info.outputPath("methode.png"), contentType: "image/png" });
  await toc.getByRole("link", { name: "Comment une action est mesurée" }).click();
  await expect(page.locator("#mesure h2")).toBeInViewport();
});
