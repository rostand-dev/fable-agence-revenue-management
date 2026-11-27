import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { deplierDossier } from "./helpers/dossier";

// US-065 : l'historique des transitions d'une action s'affiche dans le dossier, sans débordement, sur les trois formats.
test("Dossier tranché : l'historique des transitions est lisible et ordonné", async ({ page }) => {
  await page.goto("/historique");
  const hrefs = await page.locator('a[href^="/dossier/S-"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));
  expect(hrefs.length, "aucun dossier dans l'historique de démonstration").toBeGreaterThan(0);
  let found = false;
  for (const href of hrefs.slice(0, 15)) {
    await page.goto(href);
    await deplierDossier(page);
    const tr = page.getByTestId("transitions");
    if (!(await tr.count())) continue;
    await expect(tr.getByRole("heading", { name: "Historique des transitions" })).toBeVisible();
    const items = tr.locator("li");
    expect(await items.count()).toBeGreaterThan(2);
    await expect(items.first()).toContainText("création");
    await expect(items.last()).toContainText("Clôturée");
    await expectNoHorizontalOverflow(page, "historique des transitions");
    await tr.scrollIntoViewIfNeeded();
    await tr.screenshot({ path: test.info().outputPath("transitions.png") });
    await test.info().attach("transitions", { path: test.info().outputPath("transitions.png"), contentType: "image/png" });
    found = true;
    break;
  }
  expect(found, "aucun dossier avec historique de transitions").toBe(true);
});
