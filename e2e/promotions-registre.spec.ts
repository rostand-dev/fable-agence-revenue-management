import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import pg from "pg";
import { createRoleUser, deleteUser, hasDatabase } from "./helpers/roles";

// US-100 : registre des promotions d'un logement : déclaration, modification, vérification, fin ; cumul inconnu signalé ; rôle en lecture seule.
// Lisible sans défilement horizontal sur bureau, 390 px et 360 px. Chaque projet (largeur) crée ses propres promotions, repérées par une étiquette, et les retire.
async function premierLogement(page: Page): Promise<string> {
  await page.goto("/logements");
  const hrefs = await page.locator('.content a[href^="/logements/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!).filter((h) => /^\/logements\/[^/]+$/.test(h) && !h.endsWith("/nouveau")));
  expect(hrefs.length, "aucun logement dans la démonstration").toBeGreaterThan(0);
  return hrefs[0];
}
/**
 * Restes d'un essai interrompu (une promotion non terminée du même projet bloquerait la déclaration suivante : contrôle de doublon).
 * Seules les promotions de plus de 10 minutes sont retirées : les trois tests du fichier tournent en parallèle dans le même projet, et un nettoyage
 * plus large supprimait la promotion d'un test en cours (« Promotion introuvable » à la modification).
 */
test.beforeEach(async () => {
  if (!hasDatabase()) return;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try { await c.query("delete from promotions where label ~ $1 and created_at < now() - interval '10 minutes'", [`^(Semaine|Mobile) ${test.info().project.name.replace(/\W/g, "")}[0-9a-z]+$`]); } finally { await c.end(); }
});
const tag = () => test.info().project.name.replace(/\W/g, "") + Date.now().toString(36);
// Les trois largeurs tournent en parallèle sur le même logement : chacune a sa propre plage de dates, pour ne jamais se heurter au contrôle de doublon.
const iso = (n: number) => new Date(Date.now() + (n + 100 * ({ bureau: 0, "mobile-390": 1, "mobile-360": 2 }[test.info().project.name] ?? 3)) * 86_400_000).toISOString().slice(0, 10);

test("Registre des promotions : déclarer, modifier, vérifier, terminer", async ({ page }, info) => {
  const href = await premierLogement(page);
  await page.goto(`${href}?tab=canaux`);
  const registry = page.getByTestId("promo-registry");
  await expect(registry).toBeVisible();
  await expect(registry.getByRole("heading", { name: "Registre des promotions" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "registre des promotions");

  // déclaration : une remise de durée de séjour (Airbnb), étiquette unique par projet (le logement de démonstration porte déjà Genius et un tarif par pays)
  const name = `Semaine ${tag()}`;
  await registry.getByTestId("promo-add").locator("summary").click();
  const add = registry.getByTestId("promo-add");
  await add.getByLabel(/Canal et type de promotion/).selectOption("AIRBNB:LOS");
  await add.getByLabel("Nom dans l'extranet").fill(name);
  await add.getByLabel(/Remise \(%\)/).fill("9.5");
  await add.getByLabel("Séjours à partir du").fill(iso(14));
  await add.getByLabel(/Séjours jusqu'au/).fill(iso(30));
  await add.getByLabel("Séjour minimal (nuits)").fill("7");
  await add.getByLabel("Identifiant dans l'extranet").fill("BK-E2E-1");
  await expectNoHorizontalOverflow(page, "formulaire de déclaration ouvert");
  await add.getByRole("button", { name: "Ajouter au registre" }).click();
  await expect(add.getByText("Promotion ajoutée au registre.")).toBeVisible();

  const card = registry.getByTestId("promo-card").filter({ has: page.getByRole("heading", { name }) });
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute("data-state", "ACTIVE");
  await expect(card).toContainText("−9,5 %");
  await expect(card).toContainText("Airbnb · Remise de durée de séjour");
  await expect(card).toContainText("Tous les voyageurs");
  await expect(card).toContainText("7 nuits");
  await expect(card).toContainText("BK-E2E-1");
  await expect(card).toContainText("aujourd'hui");
  await expectNoHorizontalOverflow(page, "registre avec la promotion déclarée");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: info.outputPath("promotion.png") });
  await info.attach("promotion", { path: info.outputPath("promotion.png"), contentType: "image/png" });

  // doublon refusé, message lisible, rien d'ajouté
  await add.getByLabel(/Canal et type de promotion/).selectOption("AIRBNB:LOS");
  await add.getByLabel(/Remise \(%\)/).fill("5");
  await add.getByLabel("Séjours à partir du").fill(iso(20));
  await add.getByLabel(/Séjours jusqu'au/).fill(iso(25));
  await add.getByRole("button", { name: "Ajouter au registre" }).click();
  await expect(add.getByRole("alert")).toContainText("couvre déjà ces séjours");
  await expect(card).toHaveCount(1);

  // saisie invalide refusée : remise hors bornes (le navigateur bloque, on contourne par une valeur acceptée par le champ mais refusée par le serveur)
  await add.getByLabel(/Remise \(%\)/).evaluate((el) => { (el as HTMLInputElement).removeAttribute("max"); });
  await add.getByLabel(/Remise \(%\)/).fill("95");
  await add.getByRole("button", { name: "Ajouter au registre" }).click();
  await expect(add.getByRole("alert")).toContainText("entre 1 et 80");

  // modification : la remise change, la vérification est remise à zéro
  await card.locator("summary", { hasText: /^Modifier/ }).click();
  await card.getByLabel(/Remise \(%\)/).fill("12");
  await card.getByRole("button", { name: "Enregistrer" }).click();
  await expect(card).toContainText("−12 %");
  await expect(card).toContainText("Jamais vérifiée");
  await expectNoHorizontalOverflow(page, "promotion modifiée");

  // vérification : repart pour sept jours
  await card.getByRole("button", { name: "Marquer vérifiée" }).click();
  await expect(card).toContainText("aujourd'hui");
  await expect(card).not.toContainText("Jamais vérifiée");

  // fin : la carte quitte la liste en cours et rejoint « terminées », avec son motif
  await card.locator("summary", { hasText: /^Terminer/ }).click();
  await card.getByLabel("Motif (facultatif)").fill("Arrêtée pendant le test");
  await card.getByRole("button", { name: "Terminer la promotion" }).click();
  await expect(card).toHaveCount(0);
  await registry.getByText(/Promotions terminées/).click();
  const ended = registry.getByTestId("promo-ended").getByTestId("promo-card").filter({ has: page.getByRole("heading", { name }) });
  await expect(ended).toHaveAttribute("data-state", "ENDED");
  await expect(ended).toContainText("Arrêtée pendant le test");
  await expectNoHorizontalOverflow(page, "promotion terminée");

  // la chronologie du logement garde les gestes
  await page.goto(`${href}?tab=historique`);
  const trail = page.getByTestId("historique-logement");
  await expect(trail).toContainText("Promotion terminée");
  await expect(trail).toContainText("Promotion vérifiée dans l'extranet");
  await expect(trail).toContainText("Promotion modifiée au registre");
  await expect(trail).toContainText("Promotion déclarée au registre");
  await expectNoHorizontalOverflow(page, "chronologie du logement");
});

test("Registre des promotions : un cumul inconnu est signalé", async ({ page }, info) => {
  const href = await premierLogement(page);
  await page.goto(`${href}?tab=canaux`);
  const registry = page.getByTestId("promo-registry");
  // le logement de démonstration porte déjà « Genius » en permanence : un tarif mobile sur les mêmes séjours a une règle de cumul inconnue (US-003)
  const m = `Mobile ${tag()}`;
  const add = registry.getByTestId("promo-add");
  await add.locator("summary").click();
  await add.getByLabel(/Canal et type de promotion/).selectOption("BOOKING:MOBILE");
  await add.getByLabel("Nom dans l'extranet").fill(m);
  await add.getByLabel(/Remise \(%\)/).fill("7");
  await add.getByLabel("Séjours à partir du").fill(iso(60));
  await add.getByLabel(/Séjours jusqu'au/).fill(iso(70));
  await add.getByRole("button", { name: "Ajouter au registre" }).click();
  await expect(add.getByText("Promotion ajoutée au registre.")).toBeVisible();
  const cm = registry.getByTestId("promo-card").filter({ has: page.getByRole("heading", { name: m }) });
  await expect(cm).toContainText("Cumul inconnu avec");
  await expect(cm).toContainText("« Genius »");
  await expect(cm).toContainText("Voyageurs sur mobile");
  await expectNoHorizontalOverflow(page, "cumul inconnu");
  await cm.scrollIntoViewIfNeeded();
  await cm.screenshot({ path: info.outputPath("cumul-inconnu.png") });
  await info.attach("cumul-inconnu", { path: info.outputPath("cumul-inconnu.png"), contentType: "image/png" });
  await cm.locator("summary", { hasText: /^Terminer/ }).click();
  await cm.getByRole("button", { name: "Terminer la promotion" }).click();
  await expect(cm).toHaveCount(0);
});

test.describe("rôles", () => {
  test.skip(!hasDatabase(), "DATABASE_URL absent : comptes de rôles non créables sur cet environnement");
  test.use({ storageState: { cookies: [], origins: [] } });
  async function login(page: Page, u: { email: string; password: string }) {
    await page.goto("/connexion");
    await page.getByLabel("Adresse e-mail").fill(u.email);
    await page.getByLabel("Mot de passe").fill(u.password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 15_000 });
  }
  test("Analyste : le registre est lisible mais sans bouton de modification ; opérateur OTA : il peut le tenir", async ({ page }) => {
    const analyste = await createRoleUser("ANALYST", tag());
    const operateur = await createRoleUser("OTA_OPERATOR", tag());
    try {
      await login(page, analyste);
      const href = await premierLogement(page);
      await page.goto(`${href}?tab=canaux`);
      await expect(page.getByTestId("promo-registry")).toBeVisible();
      await expect(page.getByTestId("promo-readonly")).toContainText("Votre rôle (Analyste) ne permet pas de tenir le registre des promotions");
      await expect(page.getByTestId("promo-add")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Marquer vérifiée|Terminer la promotion|Enregistrer/ })).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "registre en lecture seule");
      await page.context().clearCookies();
      await login(page, operateur);
      await page.goto(`${href}?tab=canaux`);
      await expect(page.getByTestId("promo-add")).toBeVisible();
    } finally { await deleteUser(analyste.id); await deleteUser(operateur.id); }
  });
});
