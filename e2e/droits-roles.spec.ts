import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { createRoleUser, deleteUser, hasDatabase } from "./helpers/roles";

// US-084 : un rôle sans droit lit les dossiers mais ne peut ni approuver, ni rejeter, ni différer ; le serveur refuse aussi (403).
// Les comptes de test vivent dans l'espace du compte de démo ; ils exigent DATABASE_URL (ignorés sur une Preview distante).
test.skip(!hasDatabase(), "DATABASE_URL absent : comptes de rôles non créables sur cet environnement");
test.use({ storageState: { cookies: [], origins: [] } });

async function login(page: Page, u: { email: string; password: string }) {
  await page.goto("/connexion");
  await page.getByLabel("Adresse e-mail").fill(u.email);
  await page.getByLabel("Mot de passe").fill(u.password);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/connexion"), { timeout: 15_000 });
}
const tag = () => test.info().project.name.replace(/\W/g, "") + "-" + test.info().parallelIndex + "-" + Date.now().toString(36);
const dossierHrefs = (page: Page) => page.locator('a[href^="/dossier/"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));

test("Analyste : lecture seule dans la boîte d'opportunités, le dossier et l'historique", async ({ page }) => {
  const u = await createRoleUser("ANALYST", tag());
  try {
    await login(page, u);
    await expect(page.getByTestId("lecture-seule")).toContainText("Votre rôle (Analyste) ne permet pas de décider");
    await expect(page.getByRole("button", { name: /^Approuver$|Retenir l'inaction|Différer/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "Inbox en lecture seule");

    const hrefs = await dossierHrefs(page);
    expect(hrefs.length, "aucun dossier dans la démonstration").toBeGreaterThan(0);
    await page.goto(hrefs[0]);
    await expect(page.getByTestId("lecture-seule")).toBeVisible();
    await expect(page.getByRole("button", { name: /Approuver|Rejeter la proposition|Retenir l'inaction|Différer/ })).toHaveCount(0);
    await page.getByTestId("lecture-seule").scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, "dossier en lecture seule");
    // US-083 : sans droit de lecture du journal, la traçabilité est refusée et ne fuit aucun événement
    await expect(page.getByTestId("trace-audit")).toContainText(/ne permet pas|réservé/i);
    await expect(page.getByTestId("trace-audit").locator("ol.trace-list")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("analyste-dossier.png") });
    await test.info().attach("analyste-dossier", { path: test.info().outputPath("analyste-dossier.png"), contentType: "image/png" });

    await page.goto("/historique#journal");
    await expect(page.getByTestId("journal-reserve")).toContainText("Journal réservé");
    await expectNoHorizontalOverflow(page, "historique sans journal");

    await page.goto("/parametres/compte#droits");
    const droits = page.getByTestId("droits");
    await expect(droits).toContainText("Analyste");
    await expect(droits.getByRole("row", { name: /Approuver, rejeter/ })).toContainText("Non autorisé");
    await expectNoHorizontalOverflow(page, "compte : droits");

    await page.goto("/parametres/demo");
    await expect(page.locator(".content")).toContainText("La réinstallation est réservée aux rôles qui décident.");
    await expect(page.getByRole("button", { name: /Réinstaller la démonstration/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "démonstration en lecture seule");
  } finally { await deleteUser(u.id); }
});

test("Analyste : le serveur refuse l'approbation par l'API (403) et le journal d'audit (403)", async ({ page }) => {
  const u = await createRoleUser("ANALYST", tag());
  try {
    await login(page, u);
    const res = await page.request.post("/api/v1/opportunities/opp_inexistant/approve", { data: { candidate: 0, comment: "Test de refus" } });
    expect(res.status()).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    const rej = await page.request.post("/api/v1/opportunities/opp_inexistant/reject", { data: {} });
    expect(rej.status()).toBe(403);
    const audit = await page.request.get("/api/audit-events?limit=5");
    expect(audit.status()).toBe(403);
  } finally { await deleteUser(u.id); }
});

test("Auditeur : lit le journal d'audit, sans aucun bouton de décision", async ({ page }) => {
  const u = await createRoleUser("AUDITOR", tag());
  try {
    await login(page, u);
    await expect(page.getByRole("button", { name: /^Approuver$|Retenir l'inaction|Différer/ })).toHaveCount(0);
    await page.goto("/historique#journal");
    await expect(page.getByTestId("journal-reserve")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Journal d'audit" })).toBeVisible();
    await expect(page.locator("ul.timeline").last().locator("li").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "journal de l'auditeur");
    expect((await page.request.get("/api/audit-events?limit=5")).status()).toBe(200);
  } finally { await deleteUser(u.id); }
});

test("Revenue manager : décide comme le propriétaire du compte (non-régression)", async ({ page }) => {
  const u = await createRoleUser("REVENUE_MANAGER", tag());
  try {
    await login(page, u);
    await expect(page.getByTestId("lecture-seule")).toHaveCount(0);
    const hrefs = await dossierHrefs(page);
    expect(hrefs.length).toBeGreaterThan(0);
    await page.goto(hrefs[0]);
    await expect(page.getByTestId("lecture-seule")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Rejeter la proposition" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "dossier du revenue manager");
  } finally { await deleteUser(u.id); }
});
