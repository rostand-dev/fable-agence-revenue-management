import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { deplierDossier } from "./helpers/dossier";

// US-072 : avis d'Elias (tarif) et de Hugo (distribution) sous les options d'un dossier. Bureau, mobile 390 et 360 px.
async function dossierAvecAvis(page: Page): Promise<string> {
  await page.goto("/");
  const hrefs = await page.locator('a[href^="/dossier/"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));
  for (const h of hrefs) {
    await page.goto(h);
    await deplierDossier(page);
    if (await page.getByTestId("avis-strateg").count()) return h;
  }
  throw new Error("aucun dossier du compte de démo ne porte d'avis de stratège");
}

test("Dossier : chaque option d'un stratège porte son avis (position, justification), sans débordement", async ({ page }) => {
  await dossierAvecAvis(page);
  const avis = page.getByTestId("avis-strateg");
  const n = await avis.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const a = avis.nth(i);
    await expect(a).toBeVisible();
    await expect(a.locator(".state")).toHaveText(/^(favorable|avec réserves|défavorable)$/);
    expect(["pricing", "distribution"]).toContain(await a.getAttribute("data-agent"));
  }
  await expectNoHorizontalOverflow(page, "dossier : avis des stratèges");
  await avis.first().scrollIntoViewIfNeeded();
  await avis.first().screenshot({ path: test.info().outputPath("avis.png") });
  await test.info().attach("avis", { path: test.info().outputPath("avis.png"), contentType: "image/png" });
});

test("Dossier : l'avis ne change ni l'option recommandée ni le verdict de l'auditeur", async ({ page }) => {
  await dossierAvecAvis(page);
  // une option rejetée par l'auditeur n'est jamais présentée comme favorable
  const rejetees = page.locator("article.option.is-rejected");
  for (const r of await rejetees.all()) {
    for (const a of await r.getByTestId("avis-strateg").all()) await expect(a.locator(".state")).toHaveText("défavorable");
  }
  await expect(page.locator("article.option .tag", { hasText: "recommandée" })).toHaveCount(1);
});
