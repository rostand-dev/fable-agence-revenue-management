import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { withApprovedManualDossier } from "./helpers/dossier";
import { hasDatabase } from "./helpers/roles";

// US-110 : à la confirmation d'une action, sa référence (baseline) est figée et les fenêtres de mesure sont affichées. Trois largeurs, sans débordement.
test.skip(!hasDatabase(), "DATABASE_URL absent : dossier de test non créable sur cet environnement");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });

test("Expérience : avant l'exécution rien n'est figé ; la confirmation fige la référence et affiche les fenêtres", async ({ page }) => {
  await withApprovedManualDossier(async (code) => {
    await page.goto(`/dossier/${code}`);
    await expect(page.getByTestId("experiment-panel")).toHaveCount(0);

    await page.getByLabel(/Portée réellement appliquée/).fill("Promotion retirée dans l'extranet pour les dates du dossier");
    await page.getByLabel(/Date d'entrée en vigueur/).fill(today());
    await page.getByLabel(/Identifiant dans l'extranet/).fill("BK-E2E-110");
    await page.getByLabel("Preuve", { exact: true }).fill("Capture de l'extranet");
    await page.getByRole("button", { name: "Déclarer la réalisation" }).click();

    const panel = page.getByTestId("experiment-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("En attente de vérification");
    await expect(panel).toContainText("Entrée en vigueur");
    await expect(panel).toContainText("Fenêtre de référence");
    await expect(panel).toContainText("14 jours avant l'action");
    // l'observation n'est fixée qu'à la vérification de l'action : jamais une date inventée avant
    await expect(panel).toContainText("pas encore fixée");
    // une donnée absente s'affiche « inconnue », jamais comme un zéro : soit la référence est complète, soit sa limite est dite
    const sufficient = await panel.getAttribute("data-sufficient");
    if (sufficient === "false") await expect(page.getByTestId("experiment-limits")).toContainText("Référence insuffisante");
    else await expect(panel).toContainText("elle ne change plus");

    await panel.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, "dossier avec expérience");

    // la fiche reste cohérente après rechargement : l'expérience est lue en base, pas en mémoire
    await page.reload();
    await expect(page.getByTestId("experiment-panel")).toContainText("En attente de vérification");
  });
});

test("Glossaire : le terme « Référence avant action » est expliqué", async ({ page }) => {
  await page.goto("/glossaire");
  await expect(page.getByText("Référence avant action").first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "glossaire");
});
