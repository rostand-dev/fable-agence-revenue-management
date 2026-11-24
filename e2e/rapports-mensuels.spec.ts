import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { createRoleUser, deleteUser, hasDatabase } from "./helpers/roles";

// US-112 : rapport mensuel certifié : préparer, retoucher (nombre inventé refusé), certifier, figé, nouvelle version, lecture seule.
// Trois largeurs, sans débordement. Les trois projets tournent en parallèle sur le même logement : chacun travaille sur son propre mois.
test.skip(!hasDatabase(), "DATABASE_URL absent : espace de test non modifiable sur cet environnement");

function monthValue(offset: number): string {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const slot = () => ({ bureau: 3, "mobile-390": 4, "mobile-360": 5 } as Record<string, number>)[test.info().project.name] ?? 6;
async function clean() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    // un rapport certifié ne se supprime pas par l'application : le nettoyage de test passe outre le déclencheur de suppression
    await c.query("set session_replication_role = replica");
    await c.query("delete from monthly_reports where month = $1", [monthValue(slot())]);
  } finally { await c.end(); }
}
test.beforeEach(clean);
test.afterEach(clean);

async function login(page: Page, u: { email: string; password: string }) {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(u.email);
  await page.getByLabel("Mot de passe").fill(u.password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 15_000 });
}

test("Rapport mensuel : préparer, refuser un nombre inventé, certifier, figé, corriger par une nouvelle version", async ({ page }) => {
  await page.goto("/rapports");
  await expect(page.getByRole("heading", { name: /Rapports mensuels/ }).first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "liste des rapports");
  await page.getByLabel("Mois à rapporter").selectOption(monthValue(slot()));
  await page.getByRole("button", { name: "Préparer ou actualiser le rapport" }).click();
  await expect(page.getByText("Rapport préparé")).toBeVisible();
  await expect(page.locator('[data-testid="rapport-ligne"][data-status="DRAFT"]').first()).toBeVisible();

  await page.locator('[data-testid="rapport-ligne"][data-status="DRAFT"]').first().getByRole("link").click();
  await expect(page.getByTestId("rapport-etat")).toContainText("Brouillon");
  await expect(page.getByTestId("rapport-metriques")).toBeVisible();
  await expect(page.getByTestId("rapport-actions")).toContainText("Effet incrémental");
  await expectNoHorizontalOverflow(page, "brouillon de rapport");

  // un nombre absent des métriques est refusé, le texte enregistré reste l'ancien
  const area = page.getByLabel("Texte du rapport");
  const before = await area.inputValue();
  await area.fill(`${before}\n\nGain exceptionnel de 98765 € constaté.`);
  await page.getByRole("button", { name: "Enregistrer le texte" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "98765" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Texte du rapport")).toHaveValue(before);

  // un texte retouché sans nombre inventé est enregistré
  await page.getByLabel("Texte du rapport").fill(`${before}\n\nRelu et validé.`);
  await page.getByRole("button", { name: "Enregistrer le texte" }).click();
  await expect(page.getByText("Texte enregistré.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Régénérer \(efface mes retouches\)/ })).toBeVisible();

  // certifier sans cocher la case de relecture est refusé
  await page.getByRole("button", { name: "Certifier le rapport" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "case de relecture" })).toBeVisible();
  await expect(page.getByTestId("rapport-etat")).toContainText("Brouillon");
  // texte modifié mais non enregistré : c'est le texte affiché qui est certifié
  await page.getByLabel("Texte du rapport").fill(`${before}\n\nRelu, non enregistré.`);
  await page.getByLabel(/J'ai relu les chiffres/).check();
  await page.getByRole("button", { name: "Certifier le rapport" }).click();
  await expect(page.getByTestId("rapport-etat")).toContainText("Certifié");
  await expect(page.getByTestId("rapport-empreinte")).toContainText(/[0-9a-f]{16}/);
  await expect(page.getByTestId("rapport-texte")).toContainText("Relu, non enregistré.");
  await expect(page.getByLabel("Texte du rapport")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Certifier le rapport" })).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "rapport certifié");

  // corriger : nouvelle version, la certifiée reste lisible et intacte
  await page.getByRole("button", { name: "Ouvrir une nouvelle version" }).click();
  await expect(page.getByText("Rapport préparé")).toBeVisible();
  await page.goto("/rapports");
  const lignes = page.getByTestId("rapport-ligne");
  await expect(page.locator('[data-testid="rapport-ligne"][data-status="CERTIFIED"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="rapport-ligne"][data-status="DRAFT"]')).toHaveCount(1);
  await expect(lignes.filter({ hasText: "une nouvelle version est en brouillon" })).toHaveCount(1);
  await expectNoHorizontalOverflow(page, "liste avec deux versions");
});

test("Rapport mensuel : un analyste lit sans pouvoir préparer ni certifier ; le bilan renvoie vers les rapports", async ({ page }, info) => {
  // un rapport certifié existe pour ce mois (créé par le propriétaire du compte de démo)
  await page.goto("/rapports");
  await page.getByLabel("Mois à rapporter").selectOption(monthValue(slot()));
  await page.getByRole("button", { name: "Préparer ou actualiser le rapport" }).click();
  await expect(page.getByText("Rapport préparé")).toBeVisible();
  const u = await createRoleUser("ANALYST", `rapport${info.project.name.replace(/\W/g, "")}${Date.now().toString(36)}`);
  try {
    await page.context().clearCookies();
    await login(page, u);
    await page.goto("/rapports");
    await expect(page.getByTestId("rapport-reserve")).toBeVisible();
    await expect(page.getByRole("button", { name: "Préparer ou actualiser le rapport" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "rapports en lecture seule");
    await page.getByTestId("rapport-ligne").first().getByRole("link").click();
    await expect(page.getByTestId("rapport-texte")).toBeVisible();
    await expect(page.getByRole("button", { name: /Certifier/ })).toHaveCount(0);
    await expect(page.getByLabel("Texte du rapport")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "brouillon en lecture seule");
    await page.goto("/bilan");
    await page.getByTestId("lien-rapports").click();
    await expect(page).toHaveURL(/\/rapports/);
  } finally { await deleteUser(u.id); }
});

test("Glossaire : le terme « Rapport certifié » est expliqué", async ({ page }) => {
  await page.goto("/glossaire");
  await expect(page.getByText("Rapport certifié").first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "glossaire");
});
