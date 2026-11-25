import { expect, test } from "@playwright/test";
import pg from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { hasDatabase } from "./helpers/roles";

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

test("Mobile : la feuille « Plus » montre les quatre écrans IA quand la branche est ouverte", async ({ page }) => {
  test.skip(page.viewportSize()!.width >= 768, "barre basse : mobile seulement");
  await page.goto("/modeles/cles");
  const plus = page.getByRole("navigation", { name: "Navigation principale" }).getByRole("button", { name: "Plus" });
  const sheet = page.getByRole("dialog", { name: "Tous les écrans" });
  await expect(async () => { if (!(await sheet.isVisible())) await plus.click(); await expect(sheet).toBeVisible({ timeout: 1000 }); }).toPass();
  await expect(sheet.getByRole("link", { name: /^Clés fournisseurs/ })).toHaveAttribute("aria-current", "page");
  await expectNoHorizontalOverflow(page, "feuille Plus, branche IA");
  await capture(page, "feuille-ia");
  await sheet.getByRole("link", { name: /^Budget/ }).click();
  await expect(page).toHaveURL(/\/modeles\/budget$/);
});

test("Prix à valider : pastille dans le menu et sur la carte Catalogue", async ({ page }, info) => {
  // écrit un relevé de prix en attente, partagé par tous les comptes : un seul format suffit, sur base éphémère
  test.skip(!hasDatabase() || !!process.env.E2E_BASE_URL?.trim() || info.project.name !== "bureau", "base locale, un seul format");
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  const id = "price_e2e_hub";
  try {
    await db.query("delete from llm_price_snapshots where id = $1 or (model_id = 'gpt-6-luna' and status = 'PENDING')", [id]);
    await db.query("insert into llm_models (model_id, provider, label, tier) values ('gpt-6-luna','openai','GPT-6 Luna','eco') on conflict (model_id) do nothing");
    await db.query("insert into llm_price_snapshots (id, model_id, input_usd_per_mtok, output_usd_per_mtok, source, status) values ($1,'gpt-6-luna',9,18,'e2e','PENDING')", [id]);
    await page.goto("/modeles");
    await expect(page.getByTestId("hub-card-catalogue")).toContainText("nouveau prix à valider");
    const rail = page.getByRole("navigation", { name: "Navigation du cockpit" });
    await expect(rail.getByRole("link", { name: /Catalogue/ }).getByRole("img", { name: /prix à valider/ })).toBeVisible();
    await capture(page, "hub-prix");
    // la décision ramène au Catalogue avec sa confirmation
    await page.goto("/modeles/catalogue");
    await page.getByTestId("model-gpt-6-luna").getByRole("button", { name: "Refuser" }).click();
    await expect(page).toHaveURL(/\/modeles\/catalogue\?prix=refuse$/);
    await expect(page.getByTestId("prix-decide")).toContainText("refusé");
  } finally { await db.query("delete from llm_price_snapshots where id = $1", [id]); await db.end(); }
});
