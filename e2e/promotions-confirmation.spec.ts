import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { withApprovedManualDossier } from "./helpers/dossier";
import { hasDatabase } from "./helpers/roles";

// US-103 : confirmation de l'opérateur (identifiant ou preuve, date d'entrée en vigueur) et arrêt en cas d'écart. Trois largeurs, sans débordement.
test.skip(!hasDatabase(), "DATABASE_URL absent : dossier de test non créable sur cet environnement");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });

test("Confirmation : refusée sans identifiant ni preuve, acceptée avec, récapitulatif complet", async ({ page }) => {
  await withApprovedManualDossier(async (code) => {
    await page.goto(`/dossier/${code}`);
    await page.getByLabel(/Portée réellement appliquée/).fill("Promotion retirée dans l'extranet pour les dates du dossier");
    await page.getByLabel(/Date d'entrée en vigueur/).fill(today());
    await page.getByLabel("Preuve", { exact: true }).scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, "formulaire de confirmation");
    await page.getByRole("button", { name: "Déclarer la réalisation" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "identifiant" })).toBeVisible();
    await expect(page.getByTestId("execution-reservee")).toHaveCount(0);

    await page.getByLabel(/Identifiant dans l'extranet/).fill("BK-E2E-7");
    await page.getByLabel("Preuve", { exact: true }).fill("Capture : https://exemple.test/c/7");
    await page.getByRole("button", { name: "Déclarer la réalisation" }).click();
    const recap = page.getByText("Identifiant dans l'extranet").first();
    await expect(recap).toBeVisible();
    await expect(page.getByText("BK-E2E-7").first()).toBeVisible();
    await expect(page.getByText("Capture : https://exemple.test/c/7").first()).toBeVisible();
    await expect(page.getByText("Date d'entrée en vigueur").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Voir dans le registre du logement" })).toBeVisible();
    // la preuve reste du texte : jamais un lien suivi par l'application
    await expect(page.getByRole("link", { name: /exemple\.test/ })).toHaveCount(0);
    await recap.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, "récapitulatif de confirmation");
  });
});

test("Écart : l'action est arrêtée, un incident est ouvert, rien n'est confirmé", async ({ page }) => {
  await withApprovedManualDossier(async (code) => {
    await page.goto(`/dossier/${code}`);
    const ecart = page.getByTestId("ecart");
    await ecart.locator("summary").click();
    await expectNoHorizontalOverflow(page, "formulaire d'écart ouvert");
    await ecart.getByLabel(/Écart constaté/).fill("Booking affiche 12 % alors que 8 % étaient approuvés.");
    await ecart.getByRole("button", { name: "Signaler un écart et arrêter" }).click();
    await expect(page.getByText(/Écart signalé : l'action est arrêtée/)).toBeVisible();
    const alerts = page.getByTestId("dossier-alerts");
    await expect(alerts).toContainText("arrêtée");
    await expect(alerts).toContainText("12 %");
    // toujours approuvée : le formulaire de confirmation est encore là
    await expect(page.getByRole("button", { name: "Déclarer la réalisation" })).toBeVisible();
    await alerts.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, "dossier avec incident d'écart");
  });
});
