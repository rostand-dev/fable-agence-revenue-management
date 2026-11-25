import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { httpCredentials } from "./helpers/env";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { createRoleUser, deleteUser, hasDatabase } from "./helpers/roles";

// US-112 : rapport mensuel certifié : préparer, retoucher (nombre inventé refusé), certifier, figé, nouvelle version, lecture seule.
// Trois largeurs, sans débordement. Les trois projets tournent en parallèle sur le même logement : chacun travaille sur son propre mois.
// Dans une largeur, les tests partagent ce mois et le vident avant et après : ils passent l'un après l'autre (sinon l'un supprime ou certifie le rapport de l'autre).
test.skip(!hasDatabase(), "DATABASE_URL absent : espace de test non modifiable sur cet environnement");
// « default » : dans l'ordre, par un seul processus, malgré `fullyParallel` ; contrairement à « serial », un échec n'empêche pas les tests suivants.
test.describe.configure({ mode: "default" });

function monthValue(offset: number): string {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const slot = () => ({ bureau: 3, "mobile-390": 4, "mobile-360": 5 } as Record<string, number>)[test.info().project.name] ?? 6;
/** Ligne de rapport du mois de ce projet (les trois largeurs tournent en parallèle sur le même logement). */
const monthLabel = () => new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${monthValue(slot())}-01T00:00:00Z`));
const myRow = (page: Page, status: "DRAFT" | "CERTIFIED") => page.locator(`[data-testid="rapport-ligne"][data-status="${status}"]`).filter({ hasText: monthLabel() });
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
  await expect(myRow(page, "DRAFT").first()).toBeVisible();

  await myRow(page, "DRAFT").first().getByRole("link").click();
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
  await expect(myRow(page, "CERTIFIED")).toHaveCount(1);
  await expect(myRow(page, "DRAFT")).toHaveCount(1);
  await expect(lignes.filter({ hasText: monthLabel() }).filter({ hasText: "une nouvelle version est en brouillon" })).toHaveCount(1);
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
    await myRow(page, "DRAFT").first().getByRole("link").click();
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

test("Exports PDF et CSV d'un rapport certifié, historique filtré et exporté (US-113)", async ({ page, browser, baseURL }) => {
  await page.goto("/rapports");
  await page.getByLabel("Mois à rapporter").selectOption(monthValue(slot()));
  await page.getByRole("button", { name: "Préparer ou actualiser le rapport" }).click();
  await expect(page.getByText("Rapport préparé")).toBeVisible();
  await myRow(page, "DRAFT").first().getByRole("link").click();
  await page.waitForURL(/\/rapports\/rpt_/);
  const id = page.url().split("/rapports/")[1];

  // un brouillon ne s'exporte pas ; format inconnu refusé ; sans session : 401
  { const r0 = await page.request.get(`/api/rapports/${id}/export?format=pdf`); expect(r0.status(), `${id} ${await r0.text()}`).toBe(409); }
  expect((await page.request.get(`/api/rapports/${id}/export?format=docx`)).status()).toBe(400);
  expect((await page.request.get(`/api/rapports/inconnu/export?format=pdf`)).status()).toBe(404);
  await expect(page.getByTestId("rapport-exports")).toHaveCount(0);
  const anon = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  expect((await anon.request.get(`/api/rapports/${id}/export?format=pdf`)).status()).toBe(401);
  expect((await anon.request.get(`/api/rapports/historique?logement=x&type=rapports`)).status()).toBe(401);
  await anon.close();

  await page.getByLabel(/J'ai relu les chiffres/).check();
  await page.getByRole("button", { name: "Certifier le rapport" }).click();
  await expect(page.getByTestId("rapport-etat")).toContainText("Certifié");
  const exports = page.getByTestId("rapport-exports");
  await expect(exports).toBeVisible();
  await expectNoHorizontalOverflow(page, "rapport certifié avec exports");

  const pdf = await page.request.get(`/api/rapports/${id}/export?format=pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  expect(pdf.headers()["content-disposition"]).toMatch(new RegExp(`filename="rapport-[a-z0-9-]+-${monthValue(slot())}-v1\\.pdf"`));
  expect((await pdf.body()).subarray(0, 8).toString("latin1")).toMatch(/^%PDF-1\.4/);
  const csv = await page.request.get(`/api/rapports/${id}/export?format=csv`);
  expect(csv.status()).toBe(200);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text.startsWith("\uFEFF")).toBe(true);
  expect(text).toContain("Revenu net;");
  expect(text).toContain("Effet incrémental des actions;inconnu");
  // le lien de l'écran télécharge bien un fichier
  const dl = page.waitForEvent("download");
  await exports.getByRole("link", { name: "Exporter en PDF" }).click();
  expect((await dl).suggestedFilename()).toMatch(/^rapport-[a-z0-9-]+-\d{4}-\d{2}-v1\.pdf$/);

  // historique : filtres, compteur, réinitialisation, exports avec les mêmes filtres
  await page.goto("/rapports");
  const lignes = page.getByTestId("rapport-ligne");
  await expect(lignes.first()).toBeVisible();
  await page.getByLabel("État").selectOption("DRAFT");
  await page.getByRole("button", { name: "Filtrer" }).click();
  await expect(page.getByTestId("rapports-compteur")).toContainText("filtres actifs");
  await expect(page.locator('[data-testid="rapport-ligne"][data-status="CERTIFIED"]')).toHaveCount(0);
  await page.goto("/rapports?etat=CERTIFIED&annee=1999&resultat=n-importe-quoi");
  await expect(page.getByTestId("rapports-vide")).toContainText("Aucun rapport ne correspond");
  await expectNoHorizontalOverflow(page, "historique filtré sans résultat");
  await page.getByTestId("rapports-reinit").click();
  await expect(page.getByTestId("rapports-vide")).toHaveCount(0);
  await expect(page.getByTestId("mesures-liste")).toBeVisible();
  await expectNoHorizontalOverflow(page, "historique complet");
  const hist = await page.request.get(`/api/rapports/historique?logement=${(await page.getByTestId("export-historique-rapports").getAttribute("href"))!.match(/logement=([^&]+)/)![1]}&type=rapports&etat=CERTIFIED`);
  expect(hist.status()).toBe(200);
  const ht = await hist.text();
  expect(ht).toContain("Logement;Mois;Version;État");
  expect(ht).not.toContain(";Brouillon;");
  const mes = await page.request.get((await page.getByTestId("export-historique-mesures").getAttribute("href"))!);
  expect(mes.status()).toBe(200);
  expect(await mes.text()).toContain("Logement;Dossier;Action;Résultat");
  expect((await page.request.get("/api/rapports/historique?logement=inconnu&type=rapports")).status()).toBe(404);
  expect((await page.request.get("/api/rapports/historique?logement=x&type=autre")).status()).toBe(400);
});
