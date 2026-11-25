import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// Écran « Modèles » : plafond mensuel en euros, coût par agent avec tendance, cartes de modèles (état, prix, qualification, test).
// Bureau, mobile 390 et 360 px. Les trois formats partagent le compte de démo : le plafond posé (large, sans effet sur les agents) est retiré à la fin de chaque test.
test("Modèles : l'écran affiche plafond, coûts par agent et modèles du catalogue, sans débordement", async ({ page }) => {
  await page.goto("/modeles");
  await expect(page.getByRole("heading", { level: 1, name: "Modèles de langage" })).toBeVisible();
  // plafond : taux de conversion affiché à côté
  const plafond = page.locator("#plafond");
  await expect(plafond).toContainText("LLM_USD_EUR_RATE");
  await expect(plafond.getByLabel("Plafond mensuel (€)")).toBeVisible();
  // coûts : une ligne par agent + total
  const couts = page.getByTestId("couts-agents");
  for (const t of ["Directrice du revenue management", "Total"]) await expect(couts).toContainText(t);
  await expect(couts.locator("tbody tr").first()).toContainText(/Aucune dépense|Croissante|Stable|Décroissante/);
  // modèles du catalogue : un par fournisseur, état lisible, synthèse
  const liste = page.getByTestId("liste-modeles");
  await expect(liste.locator("article")).toHaveCount(5);
  await expect(page.getByTestId("model-claude-haiku-5-5")).toContainText("Claude Haiku 5.5");
  await expect(page.getByTestId("modeles-synthese")).toContainText("non disponible");
  await expect(page.getByTestId("model-gpt-6-luna")).toHaveAttribute("data-state", /indisponible|deprecie|prix_a_verifier/);
  await expectNoHorizontalOverflow(page, "modèles");
  await page.screenshot({ path: test.info().outputPath("modeles-page.png"), fullPage: true });
  await test.info().attach("modeles-page", { path: test.info().outputPath("modeles-page.png"), contentType: "image/png" });
});

test("Modèles : fixer puis retirer le plafond mensuel ; une saisie invalide est refusée avec un message clair", async ({ page }) => {
  await page.goto("/modeles");
  const f = page.locator("#plafond");
  await f.getByLabel("Plafond mensuel (€)").fill("-5");
  await f.getByRole("button", { name: "Enregistrer le plafond" }).click();
  await expect(f).toContainText("supérieur à 0");
  await f.getByLabel("Plafond mensuel (€)").fill("12,345");
  await f.getByRole("button", { name: "Enregistrer le plafond" }).click();
  await expect(f).toContainText("2 décimales au plus");
  await f.getByLabel("Plafond mensuel (€)").fill("5000,5");
  await f.getByRole("button", { name: "Enregistrer le plafond" }).click();
  await expect(f).toContainText("Plafond enregistré");
  await expectNoHorizontalOverflow(page, "modèles : plafond enregistré");
  await f.getByLabel("Plafond mensuel (€)").fill("");
  await f.getByRole("button", { name: "Enregistrer le plafond" }).click();
  await expect(f).toContainText("Plafond retiré");
});

test("Modèles : « Tester ce modèle » annonce le coût avant le clic ; sans prix connu, il est refusé et rien n'est inventé", async ({ page }) => {
  await page.goto("/modeles");
  // le compte de démo de la CI a une clé Anthropic factice (faux serveur) ; sur la Preview il n'y en a pas
  const carte = page.getByTestId("model-claude-haiku-5-5");
  const bouton = carte.getByRole("button", { name: "Tester ce modèle" });
  test.skip(!(await bouton.count()), "pas de clé Anthropic sur ce compte (Preview) : aucun test à lancer");
  await expect(carte).toContainText(/Coût estimé|Coût non chiffrable/);
  if (await carte.getByTestId("bench-estimate").count()) return; // prix connu : le lancement réel appellerait un modèle, il est couvert par les tests de base de données
  await bouton.click();
  await expect(carte).toContainText("prix de ce modèle n'est pas connu");
  await expectNoHorizontalOverflow(page, "modèles : test refusé");
});

test("Fiche agent : « Automatique » est le choix par défaut du modèle, et la navigation mène à l'écran Modèles", async ({ page }) => {
  await page.goto("/equipe/direction");
  const sel = page.locator("select#agent-model");
  test.skip(!(await sel.count()), "pas de clé sur ce compte : la liste de modèles n'est pas proposée");
  await expect(sel.locator("option").first()).toContainText("Automatique");
  await expect(sel).toHaveValue("");
  await page.goto("/integrations");
  await page.locator("#llm-keys").getByRole("link", { name: "écran Modèles" }).click();
  await expect(page).toHaveURL(/\/modeles$/);
});
