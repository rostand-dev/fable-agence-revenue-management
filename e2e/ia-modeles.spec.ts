import { expect, test } from "@playwright/test";
import pg from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { createRoleUser, deleteUser, hasDatabase } from "./helpers/roles";
import { httpCredentials } from "./helpers/env";

// Hub « IA & modèles » : quatre cartes avec leur état et leur origine, anciennes ancres, Intégrations sans les clés. Trois formats d'écran.
const CARTES = [["cles", "Clés fournisseurs"], ["agents", "Agents"], ["budget", "Budget"], ["catalogue", "Catalogue des modèles"]] as const;
const capture = async (page: import("@playwright/test").Page, nom: string) => {
  await page.screenshot({ path: test.info().outputPath(`${nom}.png`), fullPage: true });
  await test.info().attach(nom, { path: test.info().outputPath(`${nom}.png`), contentType: "image/png" });
};

test("Hub : quatre cartes avec état et origine, chacune ouvre sa page et permet de revenir", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(`${new URL(page.url()).pathname} : ${e.message}`));
  await page.goto("/modeles");
  await expect(page.getByRole("heading", { level: 1, name: "IA & modèles" })).toBeVisible();
  const hub = page.getByRole("list", { name: "Rubriques IA et modèles" });
  await expect(hub.getByRole("link")).toHaveCount(4);
  await expect(hub.locator(".hub-card-foot", { hasText: "Vient de :" })).toHaveCount(4);
  await expect(page.getByTestId("hub-card-cles")).toContainText(/[0-3] \/ 3 fournisseurs connectés/);
  await expect(page.getByTestId("hub-card-agents")).toContainText(/Automatique|Mode déterministe/);
  await expect(page.getByTestId("hub-card-budget")).toContainText(/consommés ce mois · (aucun plafond|plafond)/);
  await expect(page.getByTestId("hub-card-catalogue")).toContainText(/prix à valider/);
  await expectNoHorizontalOverflow(page, "/modeles");
  await capture(page, "hub-ia");
  for (const [carte, titre] of CARTES) {
    await page.goto("/modeles");
    await page.getByTestId(`hub-card-${carte}`).click();
    await expect(page).toHaveURL(new RegExp(`/modeles/${carte}$`));
    await expect(page.locator("h1").first()).toHaveText(titre);
    await expectNoHorizontalOverflow(page, `/modeles/${carte}`);
    await capture(page, `ia-${carte}`);
    await page.getByRole("link", { name: "Retour à IA & modèles" }).click();
    await expect(page).toHaveURL(/\/modeles$/);
  }
  expect(errors).toEqual([]);
});

test("Tablette : le hub et ses quatre pages tiennent dans 768 px", async ({ page }, info) => {
  test.skip(info.project.name !== "bureau", "une seule passe à 768 px");
  await page.setViewportSize({ width: 768, height: 1024 });
  for (const path of ["/modeles", ...CARTES.map(([c]) => `/modeles/${c}`)]) {
    await page.goto(path);
    await expect(page.locator("h1").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, `tablette ${path}`);
    await capture(page, `tablette${path.replace(/\//g, "-")}`);
  }
});

test("Anciennes ancres : chaque lien enregistré mène à la bonne sous-page", async ({ page }) => {
  for (const [depart, cible] of [["/modeles#plafond", "/modeles/budget#plafond"], ["/modeles#couts", "/modeles/budget#couts"], ["/modeles#modeles", "/modeles/catalogue#modeles"], ["/integrations#llm-keys", "/modeles/cles#llm-keys"]]) {
    await page.goto("/glossaire");
    await page.goto(depart);
    await expect(page).toHaveURL(new RegExp(`${cible}$`));
    await expect(page.locator(`#${cible.split("#")[1]}`)).toBeInViewport();
  }
});

test("Intégrations : plus de clés IA, un avis indique où elles sont, les erreurs d'ingestion sont dans la carte SuperHote", async ({ page }) => {
  await page.goto("/integrations");
  await expect(page.locator("#llm-keys")).toHaveCount(0);
  await expect(page.locator('input[name="apiKey"]')).toHaveCount(0);
  const superhote = page.locator("article.stratum", { has: page.getByRole("heading", { name: "SuperHote" }) });
  await expect(superhote.getByRole("link", { name: "Erreurs d'ingestion" })).toBeVisible();
  await expect(superhote.getByTestId("ingestion-link")).toContainText(/à traiter|Aucune en attente/);
  await expectNoHorizontalOverflow(page, "intégrations sans les clés");
  await capture(page, "integrations");
  await page.getByTestId("cles-demenagees").getByRole("link").click();
  await expect(page).toHaveURL(/\/modeles\/cles$/);
});

test("Menu : le troisième niveau n'apparaît que dans la branche ouverte", async ({ page }) => {
  const large = page.viewportSize()!.width >= 1024;
  test.skip(!large, "colonne de gauche : grand écran (la feuille est couverte par le test suivant)");
  const rail = page.getByRole("navigation", { name: "Navigation du cockpit" });
  await page.goto("/parametres");
  await expect(rail.getByRole("link", { name: "IA & modèles" })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Clés fournisseurs" })).toBeHidden();
  await page.goto("/modeles/budget");
  for (const n of ["Clés fournisseurs", "Agents", "Budget"]) await expect(rail.getByRole("link", { name: n, exact: true })).toBeVisible();
  await expect(rail.getByRole("link", { name: "Budget", exact: true })).toHaveAttribute("aria-current", "page");
});

test("Tablette : « Paramètres » mène à son accueil, son chevron ouvre ses sous-écrans", async ({ page }, info) => {
  test.skip(info.project.name !== "bureau", "une seule passe à 768 px");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/portefeuille");
  const rangee = page.getByRole("navigation", { name: "Navigation du cockpit" });
  const chevron = rangee.getByRole("button", { name: "Sous-menu Paramètres" });
  const sheet = page.getByRole("dialog", { name: "Paramètres" });
  // à toutes les largeurs de tablette, « Paramètres » et son chevron se voient sans faire défiler la rangée
  for (const width of [900, 1023, 768]) {
    await page.setViewportSize({ width, height: 1024 });
    await expect(rangee.getByRole("link", { name: /^Paramètres/ })).toBeInViewport({ ratio: 1 });
    await expect(chevron).toBeInViewport({ ratio: 1 });
  }
  await expect(async () => { if (!(await sheet.isVisible())) await chevron.click(); await expect(sheet).toBeVisible({ timeout: 1000 }); }).toPass();
  for (const n of ["Compte & sécurité", "Clés fournisseurs", "Agents", "Budget", "Catalogue"]) await expect(sheet.getByRole("link", { name: new RegExp(`^${n}`) })).toBeVisible();
  await expectNoHorizontalOverflow(page, "tablette, feuille Paramètres");
  await capture(page, "tablette-feuille-parametres");
  await sheet.getByRole("link", { name: /^Budget/ }).click();
  await expect(page).toHaveURL(/\/modeles\/budget$/);
  await expect(sheet).toBeHidden();
  await rangee.getByRole("link", { name: /^Paramètres/ }).click();
  await expect(page).toHaveURL(/\/parametres$/);
});

test("Mobile : la feuille « Plus » mène aux quatre écrans IA depuis n'importe quel écran", async ({ page }) => {
  test.skip(page.viewportSize()!.width >= 768, "barre basse : mobile seulement");
  await page.goto("/portefeuille");
  const plus = page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: "Plus" });
  const sheet = page.getByRole("dialog", { name: "Tous les écrans" });
  await expect(async () => { if (!(await sheet.isVisible())) await plus.click(); await expect(sheet).toBeVisible({ timeout: 1000 }); }).toPass();
  await sheet.locator("summary", { hasText: "Paramètres" }).click();
  for (const n of ["Clés fournisseurs", "Agents", "Budget", "Catalogue"]) await expect(sheet.getByRole("link", { name: new RegExp(`^${n}`) })).toBeVisible();
  await expectNoHorizontalOverflow(page, "feuille Plus, branche IA");
  await capture(page, "feuille-ia");
  await sheet.getByRole("link", { name: /^Budget/ }).click();
  await expect(page).toHaveURL(/\/modeles\/budget$/);
});

test("Prix à valider : pastille dans le menu (trois largeurs, tous les comptes) et sur la carte Catalogue", async ({ page, browser, baseURL }, info) => {
  // écrit un relevé de prix en attente, partagé par tous les comptes : un seul format suffit, sur base éphémère
  test.skip(!hasDatabase() || !!process.env.E2E_BASE_URL?.trim() || info.project.name !== "bureau", "base locale, un seul format");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const id = "price_e2e_hub";
  test.setTimeout(120_000);
  try {
    await db.query("delete from llm_price_snapshots where id = $1 or (model_id = 'gpt-6-luna' and status = 'PENDING')", [id]);
    await db.query("insert into llm_models (model_id, provider, label, tier) values ('gpt-6-luna','openai','GPT-6 Luna','eco') on conflict (model_id) do nothing");
    await db.query("insert into llm_price_snapshots (id, model_id, input_usd_per_mtok, output_usd_per_mtok, source, status) values ($1,'gpt-6-luna',9,18,'e2e','PENDING')", [id]);
    await page.goto("/modeles");
    await expect(page.getByTestId("hub-card-catalogue")).toContainText("nouveau prix à valider");
    const rail = page.getByRole("navigation", { name: "Navigation du cockpit" });
    await expect(rail.getByRole("link", { name: /Catalogue/ }).getByRole("img", { name: /prix à valider/ })).toBeVisible();
    await capture(page, "hub-prix");
    // tablette et mobile : la pastille remonte sur la rubrique repliée, puis se lit sur « Catalogue »
    const pastille = /prix à valider/;
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto("/portefeuille");
    for (const width of [900, 1023, 768]) {
      await page.setViewportSize({ width, height: 1024 });
      await expect(rail.getByRole("link", { name: /^Paramètres/ }).getByRole("img", { name: pastille })).toBeInViewport({ ratio: 1 });
      await expect(rail.getByRole("button", { name: "Sous-menu Paramètres" })).toBeInViewport({ ratio: 1 });
    }
    await expectNoHorizontalOverflow(page, "rangée tablette avec pastille");
    const feuille = page.getByRole("dialog", { name: "Paramètres" });
    await expect(async () => { if (!(await feuille.isVisible())) await rail.getByRole("button", { name: "Sous-menu Paramètres" }).click(); await expect(feuille).toBeVisible({ timeout: 1000 }); }).toPass();
    await expect(feuille.getByRole("link", { name: /^Catalogue/ }).getByRole("img", { name: pastille })).toBeVisible();
    await capture(page, "tablette-prix");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/portefeuille");
    const plus = page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: /Plus/ });
    await expect(plus.getByRole("img", { name: pastille })).toBeVisible();
    const tous = page.getByRole("dialog", { name: "Tous les écrans" });
    await expect(async () => { if (!(await tous.isVisible())) await plus.click(); await expect(tous).toBeVisible({ timeout: 1000 }); }).toPass();
    const titre = tous.locator("summary", { hasText: "Paramètres" });
    await expect(titre.getByRole("img", { name: pastille })).toBeVisible();
    await titre.click();
    await expect(titre.getByRole("img", { name: pastille })).toBeHidden();
    await expect(tous.getByRole("link", { name: /^Catalogue/ }).getByRole("img", { name: pastille })).toBeVisible();
    await capture(page, "mobile-prix");
    await page.setViewportSize({ width: 1280, height: 800 });
    // un autre compte voit la pastille aussi, sans pouvoir décider
    const autre = await createRoleUser("ANALYST", `prix${Date.now().toString(36)}`);
    const contexte = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials, viewport: { width: 1280, height: 800 }, locale: "fr-FR" });
    try {
      const q = await contexte.newPage();
      await q.goto("/connexion");
      await q.getByLabel("Adresse e-mail").fill(autre.email);
      await q.getByLabel("Mot de passe").fill(autre.password);
      await q.getByRole("button", { name: "Se connecter" }).click();
      await q.waitForURL((u) => !u.pathname.startsWith("/connexion"), { timeout: 15_000 });
      await q.goto("/modeles");
      await expect(q.getByRole("navigation", { name: "Navigation du cockpit" }).getByRole("link", { name: /^Catalogue|IA & modèles/ }).getByRole("img", { name: /prix en attente de l'exploitant/ }).first()).toBeVisible();
      await expect(q.getByTestId("hub-card-catalogue")).toContainText("en attente de l'exploitant");
    } finally { await contexte.close(); await deleteUser(autre.id); }
    // la décision ramène au Catalogue avec sa confirmation
    await page.goto("/modeles/catalogue");
    await page.getByTestId("model-gpt-6-luna").getByRole("button", { name: "Refuser" }).click();
    await expect(page).toHaveURL(/\/modeles\/catalogue\?prix=refuse$/);
    await expect(page.getByTestId("prix-decide")).toContainText("refusé");
  } finally { await db.query("delete from llm_price_snapshots where id = $1", [id]); await db.end(); }
});
