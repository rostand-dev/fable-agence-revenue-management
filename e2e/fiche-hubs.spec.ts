import { expect, test, type Page, type TestInfo } from "@playwright/test";
import pg from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { hasDatabase } from "./helpers/roles";
import { VERSION_COMPLETE } from "./helpers/view";

// Fiche logement en hubs : vue d'ensemble, trois hubs, carte « À faire », menu de gestion, feuille des sections. Trois formats d'écran.
// Version complète : le téléphone reçoit par défaut la fiche de poche (poche-fiche-historique.spec.ts).
test.use(VERSION_COMPLETE);
const largeur = (page: Page) => page.viewportSize()!.width;
async function demo(page: Page) {
  await page.goto("/logements");
  const href = await page.locator('.content a[href^="/logements/"]:has(.demo-pill)').first().getAttribute("href");
  expect(href).toBeTruthy();
  return href!;
}
async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
  await info.attach(name, { path: info.outputPath(`${name}.png`), contentType: "image/png" });
}

test("Vue d'ensemble : indicateurs, trois rubriques, trois situations au plus ; le détail mensuel est sur Performance", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const href = await demo(page);
  await page.goto(href);
  await expect(page.locator(".content .synth .metric")).toHaveCount(4);
  const hubs = page.getByRole("list", { name: "Rubriques du logement" });
  await expect(hubs.locator(".hub-card-head")).toHaveCount(3);
  // chaque rubrique propose un raccourci vers chacun de ses écrans ouvrables ; le calendrier et l'historique suivent
  const raccourcis = (rubrique: string) => page.getByRole("list", { name: `Raccourcis : ${rubrique}` }).getByRole("link");
  await expect(raccourcis("Stratégie & prix")).toHaveText(["Stratégie en vigueur", "Canaux et promotions", "Compilateur"]);
  await expect(raccourcis("Économie")).toHaveText(["Planchers par canal"]);
  await expect(raccourcis("Données & connexions")).toHaveText(["SuperHote", "PriceLabs", "Annonces", "Qualité des données"]);
  await expect(page.getByRole("list", { name: "Autres écrans du logement" }).getByRole("link")).toHaveText(["Calendrier 90 jours", "Historique du logement"]);
  expect(await page.locator(".content ul.timeline > li").count()).toBeLessThanOrEqual(3);
  await expect(page.getByRole("tablist", { name: "Sections du logement" })).toHaveCount(0);
  // démonstration : rien à modifier ni à supprimer
  await expect(page.getByText("Gérer le logement")).toHaveCount(0);
  await expect(page.getByTestId("pickup-7")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "vue d'ensemble");
  await shot(page, info, "fiche-apercu");

  await page.getByRole("link", { name: /Revenu mensuel et rythme de réservation/ }).click();
  await expect(page).toHaveURL(/tab=performance/);
  await expect(page.getByRole("heading", { name: "Revenu net mensuel" })).toBeVisible();
  await expect(page.getByTestId("pickup-7")).toHaveCount(5);
  await expectNoHorizontalOverflow(page, "performance");
  await page.locator(".content").getByRole("link", { name: "Vue d'ensemble", exact: true }).click();

  for (const [rubrique, hub, cartes] of [["Stratégie & prix", "strategie", 3], ["Économie", "economie", 1], ["Données & connexions", "donnees", 4]] as const) {
    await page.goto(href);
    await hubs.getByRole("link", { name: new RegExp(rubrique) }).click();
    await expect(page).toHaveURL(new RegExp(`tab=hub-${hub}`));
    await expect(page.getByTestId(`hub-${hub}`).locator(".hub-card")).toHaveCount(cartes);
    await expectNoHorizontalOverflow(page, `hub ${hub}`);
    await shot(page, info, `hub-${hub}`);
  }
  // un écran ramène à sa rubrique
  await page.getByTestId("hub-card-qualite-donnees").click();
  await expect(page).toHaveURL(/tab=donnees/);
  await page.locator(".content").getByRole("link", { name: "Données & connexions", exact: true }).click();
  await expect(page).toHaveURL(/tab=hub-donnees/);
  expect(errors).toEqual([]);
});

test("Mobile et tablette : « Section » ouvre les six sections en accordéon ; absent en grand écran", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const href = await demo(page);
  await page.goto(`${href}?tab=canaux`);
  const button = page.locator(".section-switcher-btn");
  if (largeur(page) >= 1024) { await expect(button).toBeHidden(); return; }
  await expect(button).toContainText("Section : Stratégie & prix");
  await button.click();
  const sheet = page.getByRole("dialog", { name: /sections$/ });
  await expect(sheet.getByRole("link", { name: /Canaux et promotions/ })).toHaveAttribute("aria-current", "page");
  await expect(sheet.getByRole("link", { name: "Vue d'ensemble" })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Historique" })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Qualité des données" })).toBeHidden();
  await sheet.locator("summary", { hasText: "Données & connexions" }).click();
  await expectNoHorizontalOverflow(page, "feuille des sections");
  await page.screenshot({ path: info.outputPath("sections.png") });
  await info.attach("sections", { path: info.outputPath("sections.png"), contentType: "image/png" });
  await sheet.getByRole("link", { name: "Qualité des données" }).click();
  await expect(page).toHaveURL(/tab=donnees/);
  await expect(sheet).toBeHidden();
  await expect(button).toContainText("Section : Données & connexions");
  // le focus et la réouverture : la section courante est dépliée
  await button.click();
  await expect(sheet.getByRole("link", { name: "Qualité des données" })).toBeVisible();
  await sheet.getByRole("button", { name: "Fermer" }).click();
  await expect(sheet).toBeHidden();
  expect(errors).toEqual([]);
});

test("Logement réel : « À faire » mène aux écrans, « Gérer le logement » regroupe les actions, les hubs montrent les états", async ({ page }, info) => {
  test.skip(!hasDatabase(), "Logement lancé en base : DATABASE_URL requis.");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.request.post("/api/v1/properties", { data: { name: `Hubs ${info.project.name} ${Date.now().toString(36)}`, city: "Lille", kind: "T2" } });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id as string;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try {
    // brouillon : une seule bannière de reprise, pas de menu de gestion ni de carte « À faire », même avec des valeurs provisoires
    await c.query(`update properties set economics = jsonb_set(coalesce(economics, '{}'::jsonb), '{provisional}', '["Coût du ménage"]') where id = $1`, [id]);
    await page.goto(`/logements/${id}`);
    await expect(page.getByText("Création du logement en cours")).toBeVisible();
    await expect(page.getByText("Gérer le logement")).toHaveCount(0);
    await expect(page.getByTestId("todo-card")).toHaveCount(0);

    await c.query("update properties set status = 'SHADOW', economics = economics - 'provisional' where id = $1", [id]);
    await page.goto(`/logements/${id}`);
    const todo = page.getByTestId("todo-card");
    await expect(todo).toHaveAttribute("open", "");
    await expect(todo.locator("li")).toHaveCount(2);
    await expect(todo.locator("summary")).toContainText("(2)");
    await expectNoHorizontalOverflow(page, "à faire");
    await shot(page, info, "a-faire");
    await todo.locator("summary").click();
    await expect(page.getByTestId("todo-calendrier")).toBeHidden();
    await todo.locator("summary").click();
    await page.getByTestId("todo-calendrier").getByRole("link", { name: "Connecter PriceLabs" }).click();
    await expect(page).toHaveURL(/tab=pricelabs/);
    // pas de lien vers l'écran déjà affiché
    await expect(page.getByTestId("todo-economie")).toBeVisible();
    await expect(page.getByTestId("todo-calendrier")).toHaveCount(0);

    // lecture SuperHote en échec : signalée sans mettre le jeton en cause ; une annonce archivée ne compte pas
    const archived = await page.request.post(`/api/v1/properties/${id}/listings`, { data: { channel: "AIRBNB", externalId: String(Date.now()) } });
    expect(archived.status(), await archived.text()).toBe(201);
    await c.query("update listings set status = 'ARCHIVED' where property_id = $1", [id]);
    await c.query("update properties set superhote = $2::jsonb where id = $1", [id, JSON.stringify({ rentalId: `hub-${id}`, lastSync: { ok: false, at: new Date().toISOString(), error: "Lecture impossible (essai)." } })]);
    await page.goto(`/logements/${id}`);
    await expect(page.getByTestId("todo-superhote")).toContainText("Dernière lecture SuperHote en échec");
    await expect(page.getByTestId("todo-superhote")).toContainText("Lecture impossible (essai).");
    await expect(page.getByTestId("todo-superhote")).not.toContainText("jeton");

    await page.goto(`/logements/${id}?tab=hub-donnees`);
    const hub = page.getByTestId("hub-donnees");
    await expect(hub.locator(".hub-card")).toHaveCount(8);
    await expect(page.getByTestId("hub-card-mapping")).toContainText("Incomplet");
    await expect(page.getByTestId("hub-card-checklist")).toContainText(/\d+ sur \d+ vérifiés/);
    await expect(page.getByTestId("hub-card-validations")).toContainText("0 sur 2 validées");
    await expect(page.getByTestId("hub-card-pricelabs")).toContainText("PriceLabs non connecté");
    // sans comparaison ni annonce : aucun état inventé
    await expect(page.getByTestId("hub-card-ecarts").locator(".state")).toHaveCount(0);
    await expect(page.getByTestId("hub-card-annonces").locator(".state")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "hub données");
    await shot(page, info, "hub-donnees-reel");
    await page.getByTestId("hub-card-mapping").click();
    await page.getByRole("link", { name: "Retour à Données & connexions" }).click();
    await expect(page).toHaveURL(/tab=hub-donnees/);

    await page.goto(`/logements/${id}?tab=hub-economie`);
    await expect(page.getByTestId("hub-card-couts")).toContainText("manquante");
    await expect(page.getByTestId("hub-card-planchers")).toContainText("Non calculés");

    await page.goto(`/logements/${id}`);
    await expect(page.getByRole("list", { name: "Autres écrans du logement" }).getByRole("link")).toHaveText(["Calendrier 90 jours", "Historique du logement", "Modifier le dossier", "Supprimer le logement"]);
    await page.goto(`/logements/${id}?tab=hub-economie`);

    await page.getByText("Gérer le logement").click();
    await expect(page.getByRole("link", { name: "Supprimer", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("link", { name: "Supprimer", exact: true })).toBeHidden();
    await page.getByText("Gérer le logement").click();
    await expect(page.getByRole("link", { name: "Supprimer", exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page, "menu de gestion");
    await page.screenshot({ path: info.outputPath("gerer.png") });
    await info.attach("gerer", { path: info.outputPath("gerer.png"), contentType: "image/png" });
    await page.locator(".manage-menu").getByRole("link", { name: "Modifier le dossier" }).click();
    await expect(page).toHaveURL(new RegExp(`/logements/${id}/modifier`));
    expect(errors).toEqual([]);
  } finally {
    await c.query("delete from properties where id = $1", [id]);
    await c.end();
  }
});
