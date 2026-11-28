import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { deplierDossier, dossiersTranches } from "./helpers/dossier";

// US-083 : la revue d'action montre la cascade du revenu net en barres, la jauge des planchers, les promotions empilées et la trace d'audit.
async function dossierHrefs(page: import("@playwright/test").Page, from: string) {
  await page.goto(from);
  return page.locator('a[href^="/dossier/S-"]').evaluateAll((as) => Array.from(new Set(as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!))));
}

test("Dossier ouvert : cascade en barres, planchers, promotions empilées, sans débordement", async ({ page }) => {
  const hrefs = await dossierHrefs(page, "/");
  expect(hrefs.length).toBeGreaterThan(0);
  let seen = 0;
  for (const href of hrefs.slice(0, 8)) {
    await page.goto(href);
    await deplierDossier(page);
    const wfs = page.getByTestId("waterfall");
    if (!(await wfs.count())) continue; // dossier sans simulation chiffrée (investigation, donnée à vérifier…)
    seen++;
    const first = wfs.first();
    expect(await first.locator("li").count(), "une ligne par étape").toBeGreaterThan(4);
    await expect(first.locator("li").last()).toContainText("€");
    await expect(page.getByTestId("floor-gauge")).toContainText("Plancher absolu");
    await expect(page.getByTestId("floor-gauge")).toContainText("Plancher stratégique");
    await expect(page.getByTestId("promo-stack")).toBeVisible();
    await expect(page.locator(".wf-warn")).toHaveCount(0);
    // chaque barre reste dans sa piste
    const outside = await page.locator(".wf-track").evaluateAll((tracks) => tracks.filter((t) => { const b = t.querySelector(".wf-bar") as HTMLElement | null; if (!b) return false; const a = t.getBoundingClientRect(), r = b.getBoundingClientRect(); return r.left < a.left - 1 || r.right > a.right + 1; }).length);
    expect(outside, "barres hors de leur piste").toBe(0);
    await expectNoHorizontalOverflow(page, "revue d'action " + href);
    await page.getByTestId("waterfalls").scrollIntoViewIfNeeded();
    await page.getByTestId("waterfalls").screenshot({ path: test.info().outputPath("cascade.png") });
    await test.info().attach("cascade", { path: test.info().outputPath("cascade.png"), contentType: "image/png" });
    if (seen >= 2) break;
  }
  expect(seen, "aucun dossier chiffré dans la démonstration").toBeGreaterThan(0);
});

test("Dossier tranché : la trace d'audit liste les événements du dossier", async ({ page }) => {
  const hrefs = await dossiersTranches(page);
  expect(hrefs.length).toBeGreaterThan(0);
  let found = false;
  for (const href of hrefs.slice(0, 15)) {
    await page.goto(href);
    await deplierDossier(page);
    const t = page.getByTestId("trace-audit");
    await expect(t.getByRole("heading", { name: "Traçabilité" })).toBeVisible();
    if (await t.locator("ol.trace-list li").count()) {
      await expect(t.locator("ol.trace-list li").first()).toContainText(/approuvée|rejetée|Inaction|différé|rouvert|exécutée/i);
      await expect(t.locator("ol.trace-list li time").first()).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
      await expectNoHorizontalOverflow(page, "traçabilité " + href);
      found = true; break;
    }
  }
  // la démonstration historique n'écrit pas toujours d'événements : la section doit alors dire qu'il n'y en a pas
  if (!found) await expect(page.getByTestId("trace-audit")).toContainText(/Aucun événement|journal d'audit/);
});
