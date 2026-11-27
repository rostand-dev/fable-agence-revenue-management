import { expect, test } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";

// Pages principales d'un propriétaire connecté : elles s'ouvrent, affichent un titre et tiennent dans l'écran (bureau, 390 px et 360 px).
const PAGES = ["/", "/portefeuille", "/alertes", "/logements", "/equipe", "/rapports", "/historique", "/glossaire"];
/** Réservées à l'ordinateur en mode poche (voir mode-poche.spec.ts et navigation-inventaire.spec.ts). */
const PAGES_ORDINATEUR = ["/bilan", "/integrations", "/methode", "/parametres", "/parametres/compte", "/parametres/priorisation", "/parametres/demo", "/modeles", "/modeles/cles", "/modeles/agents", "/modeles/budget", "/modeles/catalogue"];

const verifier = (pages: string[]) => {
  for (const path of pages) {
    test(`page ${path} : s'ouvre, titre visible, sans débordement`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const res = await page.goto(path);
      expect(res?.status(), `${path} : statut HTTP`).toBeLessThan(400);
      await expect(page).not.toHaveURL(/\/connexion/);
      await expect(page.locator("h1").first()).toBeVisible();
      await expect(page.getByTestId("ecran-ordinateur")).toHaveCount(0);
      await expectNoHorizontalOverflow(page, path);
      expect(errors, `${path} : erreurs JavaScript`).toEqual([]);
    });
  }
};
verifier(PAGES);
test.describe("Écrans de réglage et de lecture longue, version complète", () => {
  test.use(VERSION_COMPLETE);
  verifier(PAGES_ORDINATEUR);
});

test("la page de connexion est lisible sans session", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  const page = await ctx.newPage();
  await page.goto("/connexion");
  await expect(page.getByRole("button", { name: "Se connecter" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/connexion");
  await ctx.close();
});
