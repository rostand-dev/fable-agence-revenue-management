import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-060 : le catalogue des playbooks (page Méthode) et les mesures du signal (dossier d'opportunité). Bureau, mobile 390 et 360 px.
test("Méthode : le catalogue des 13 playbooks se déplie, avec seuils, données, repos et approbation", async ({ page }) => {
  await page.goto("/methode");
  const section = page.getByTestId("playbooks");
  await expect(section).toBeVisible();
  await expect(section.locator("li.playbook")).toHaveCount(13);
  const pb01 = section.locator("li.playbook").first();
  await expect(pb01).toContainText("PB-01");
  await pb01.locator("summary").click();
  await expect(pb01.getByRole("table")).toBeVisible();
  await expect(pb01).toContainText("Écart d'occupation au marché");
  await expect(pb01).toContainText("−18 pts");
  await expect(pb01).toContainText("Période de repos après décision");
  await expect(pb01).toContainText("14 jours");
  // tous les playbooks du catalogue sont codés : aucun ne se dit « pas encore actif »
  await expect(section.getByText("pas encore actif")).toHaveCount(0);
  const pb12 = section.locator("li.playbook", { hasText: /^PB-12/ });
  await pb12.locator("summary").click();
  await expect(pb12).toContainText("Durée minimale pendant laquelle le retard de rythme est suivi");
  await expect(pb12).toContainText("Palier de baisse du prix de base proposé");
  await expect(pb12).toContainText("Contenu ou visibilité non exclus");
  // PB-08 est codé : seuils, repos et approbateur visibles
  const pb08 = section.locator("li.playbook", { hasText: /^PB-08/ });
  await expect(pb08).not.toContainText("pas encore actif");
  await pb08.locator("summary").click();
  await expect(pb08).toContainText("Nuits rouvertes minimales");
  await expect(pb08).toContainText("Une annulation reste à traiter pendant ce nombre de jours");
  const pb09 = section.locator("li.playbook", { hasText: /^PB-09/ });
  await expect(pb09).not.toContainText("pas encore actif");
  await pb09.locator("summary").click();
  await expect(pb09).toContainText("Nuits libres consécutives minimales");
  await expect(pb09).toContainText("Occupation moyenne du marché sur le trou en dessous de laquelle");
  const pb11 = section.locator("li.playbook", { hasText: /^PB-11/ });
  await expect(pb11).not.toContainText("pas encore actif");
  await pb11.locator("summary").click();
  await expect(pb11).toContainText("Allongement relatif du délai médian de réservation");
  await expect(pb11).toContainText("Déplacement maximal de la part d'un canal");
  await expect(section.locator("li.playbook", { hasText: /^PB-04/ })).not.toContainText("pas encore actif");
  await expectNoHorizontalOverflow(page, "méthode : playbooks");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: test.info().outputPath("playbooks.png") });
  await test.info().attach("playbooks", { path: test.info().outputPath("playbooks.png"), contentType: "image/png" });
});

test("Dossier : le signal affiche ses mesures face à leur seuil, sans débordement", async ({ page }) => {
  await page.goto("/");
  const lien = page.locator('a[href^="/dossier/"]').first();
  await expect(lien, "aucun dossier trouvé sur l'accueil du compte de démo").toBeVisible();
  await lien.click();
  const card = page.getByTestId("signal-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("table")).toBeVisible();
  await expect(card.getByRole("columnheader")).toHaveText(["Mesure", "Observé", "Seuil"]);
  expect(await card.locator("tbody tr").count()).toBeGreaterThan(0);
  await expect(card).toContainText(/PB-\d\d/);
  await expectNoHorizontalOverflow(page, "dossier : signal");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: test.info().outputPath("signal.png") });
  await test.info().attach("signal", { path: test.info().outputPath("signal.png"), contentType: "image/png" });
});

// US-064 : les règles de l'auditeur et leurs codes de veto sont lisibles sur la page Méthode.
test("Méthode : les règles de l'auditeur distinguent veto et validation humaine, sans débordement", async ({ page }) => {
  await page.goto("/methode");
  const section = page.getByTestId("regles-auditeur");
  await expect(section).toBeVisible();
  const rules = section.locator("li.playbook");
  // 12 règles de base + INDEPENDENT_REVIEW (seconde lecture, US-073) + STRUCTURAL_LOCK et MAX_VARIATION_7D (verrou structurant et plafond de 7 jours)
  await expect(rules).toHaveCount(15);
  const floor = rules.filter({ hasText: "HARD_FLOOR" });
  await floor.locator("summary").click();
  await expect(floor).toContainText("L'option est rejetée (veto).");
  const scope = rules.filter({ hasText: "SCOPE" });
  await scope.locator("summary").click();
  await expect(scope).toContainText("Aucun veto");
  await expect(scope).toContainText("Validation humaine avec commentaire.");
  // un playbook cite les règles qui peuvent rejeter ses options
  const pb01 = page.getByTestId("playbooks").locator("li.playbook").first();
  await pb01.locator("summary").click();
  await expect(pb01).toContainText("Règles de l'auditeur concernées");
  await expect(pb01).toContainText("(veto)");
  await expect(pb01).toContainText("Plancher économique absolu");
  await expectNoHorizontalOverflow(page, "méthode : règles de l'auditeur");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: test.info().outputPath("auditeur.png") });
  await test.info().attach("auditeur", { path: test.info().outputPath("auditeur.png"), contentType: "image/png" });
});
