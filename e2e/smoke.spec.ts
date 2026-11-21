import { expect, test } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// Pages principales d'un propriétaire connecté : elles s'ouvrent, affichent un titre et tiennent dans l'écran (bureau, 390 px et 360 px).
const PAGES = ["/", "/logements", "/equipe", "/bilan", "/historique", "/integrations", "/glossaire", "/methode", "/reglages"];

for (const path of PAGES) {
  test(`page ${path} : s'ouvre, titre visible, sans débordement`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(path);
    expect(res?.status(), `${path} : statut HTTP`).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/connexion/);
    await expect(page.locator("h1").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, path);
    expect(errors, `${path} : erreurs JavaScript`).toEqual([]);
  });
}

test("la page de connexion est lisible sans session", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  const page = await ctx.newPage();
  await page.goto("/connexion");
  await expect(page.getByRole("button", { name: "Se connecter" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/connexion");
  await ctx.close();
});
