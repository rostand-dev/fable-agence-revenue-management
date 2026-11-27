import { expect, test, type Page } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { versionComplete } from "./helpers/view";

// Portraits de l'équipe (bureau, 390 px et 360 px) : chaque image se charge, ceux qui sont affichés restent carrés, la page ne déborde pas.
async function verifierPortraits(page: Page, path: string, minimum: number, affiches = true) {
  const res = await page.goto(path);
  expect(res?.status(), `${path} : statut HTTP`).toBeLessThan(400);
  const portraits = page.locator("img.avatar");
  await expect.poll(() => portraits.count(), { message: `${path} : nombre de portraits` }).toBeGreaterThanOrEqual(minimum);
  await expect.poll(() => portraits.evaluateAll((imgs) => (imgs as HTMLImageElement[])
    .filter((i) => !(i.complete && i.naturalWidth === 288 && i.naturalHeight === 288)).map((i) => i.getAttribute("src"))), { message: `${path} : images non chargées` }).toEqual([]);
  if (affiches) await expect(portraits.filter({ visible: true }).first(), `${path} : aucun portrait affiché`).toBeVisible();
  const deformes = await portraits.evaluateAll((imgs) => (imgs as HTMLImageElement[])
    .map((i) => ({ src: i.getAttribute("src"), w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height }))
    .filter((r) => r.w > 0 && Math.abs(r.w - r.h) > 0.5));
  expect(deformes, `${path} : portraits déformés`).toEqual([]);
  await expectNoHorizontalOverflow(page, path);
}

test("portraits de la page Équipe et d'une fiche agent", async ({ page }) => {
  await verifierPortraits(page, "/equipe", 8);
  await expect(page.locator('img.avatar[src="/avatars/v2/direction.webp"]').first()).toBeVisible();
  await verifierPortraits(page, "/equipe/direction", 1);
});

test("portraits des autres écrans (version complète)", async ({ page }) => {
  await versionComplete(page.context());
  await verifierPortraits(page, "/", 8);
  await verifierPortraits(page, "/methode", 1);
  await verifierPortraits(page, "/modeles/agents", 8);
});

test("les portraits sont gardés en cache", async ({ page }) => {
  const res = await page.request.get("/avatars/v2/direction.webp");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/webp");
  expect(res.headers()["cache-control"]).toContain("immutable");
});

test("portraits de la page de connexion, sans session", async ({ browser, baseURL }, info) => {
  const ctx = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials, viewport: info.project.use.viewport });
  const page = await ctx.newPage();
  // sous 900 px, la rangée de portraits de la page de connexion est masquée (app.css) : seul le chargement y est vérifié
  await verifierPortraits(page, "/connexion", 8, info.project.use.viewport!.width >= 900);
  await ctx.close();
});
