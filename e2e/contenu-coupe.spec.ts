import { expect, test, type Page } from "@playwright/test";
import { contenuCoupe, expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";

// Régression : « Raisonnement et preuves » prenait la largeur minimale de son tableau de mesures (580 px) et le surplus
// était coupé, sur téléphone comme sur grand écran. Même cause sur les playbooks de la page Méthode.
test.use(VERSION_COMPLETE);

const RAISONNEMENT = 'section[aria-labelledby="raison-h"]';
// largeurs en plus de celle du projet : à partir de 1024 px, le dossier passe sur deux colonnes
const GRANDS_ECRANS = [1024, 1440, 1920];

/** Dossiers de démonstration (codes « S-… » : les copies créées puis retirées par d'autres tests sont laissées de côté). */
async function dossiersDeDemo(page: Page): Promise<string[]> {
  const codes = new Set<string>();
  for (const url of ["/", "/historique"]) { // Opportunités, puis les dossiers décidés
    await page.goto(url);
    for (const href of await page.locator('a[href^="/dossier/S-"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!))) codes.add(href.split(/[?#]/)[0]);
  }
  expect(codes.size, "dossiers de démonstration trouvés").toBeGreaterThanOrEqual(5);
  return Array.from(codes).sort();
}

async function verifierDossier(page: Page, label: string) {
  expect(await contenuCoupe(page, RAISONNEMENT), `${label} : contenu coupé`).toEqual([]);
  // les petits tableaux de démonstration tiennent dans leur colonne, sans défilement interne
  const defile = await page.locator(`${RAISONNEMENT} .table-wrap`).evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className} : ${e.scrollWidth} px dans ${e.clientWidth} px`));
  expect(defile, `${label} : tableau plus large que sa colonne`).toEqual([]);
}

async function ouvrirDossier(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator(RAISONNEMENT)).toBeVisible();
}

test("dossier : « Raisonnement et preuves » entièrement lisible", async ({ page }) => {
  const urls = await dossiersDeDemo(page);
  test.setTimeout(30_000 + urls.length * 8_000);
  let mesures = 0, scores = 0;
  for (const url of urls) {
    await ouvrirDossier(page, url);
    await verifierDossier(page, url);
    await expectNoHorizontalOverflow(page, url);
    mesures += await page.locator(`${RAISONNEMENT} .signal-measures table`).count();
    scores += await page.locator(`${RAISONNEMENT} .score-table table`).count();
  }
  // les tableaux à l'origine du défaut ont bien été contrôlés
  expect(mesures, "tableaux de mesures rencontrés").toBeGreaterThan(0);
  expect(scores, "tableaux de priorité rencontrés").toBeGreaterThan(0);
});

/** Ouvre le premier dossier de démonstration qui porte le tableau des mesures (le plus récent d'abord). */
async function ouvrirDossierAvecMesures(page: Page): Promise<string> {
  for (const url of (await dossiersDeDemo(page)).reverse()) {
    await ouvrirDossier(page, url);
    if (await page.locator(`${RAISONNEMENT} .signal-measures table`).count()) return url;
  }
  throw new Error("aucun dossier de démonstration avec un tableau de mesures");
}

test("dossier sur grand écran : les deux colonnes restent lisibles", async ({ page, isMobile }) => {
  test.skip(isMobile, "largeurs de bureau et de tablette");
  const url = await ouvrirDossierAvecMesures(page);
  for (const width of GRANDS_ECRANS) {
    await page.setViewportSize({ width, height: 900 });
    await verifierDossier(page, `${url} à ${width} px`);
  }
});

test("dossier : un mot très long (adresse, identifiant) passe à la ligne au lieu d'être coupé", async ({ page }) => {
  const url = await ouvrirDossierAvecMesures(page);
  const cibles = ['[data-testid="signal-card"] > p', '[data-testid="signal-card"] .metric-source', '[data-testid="constat"] > span:first-child', ".registry .rules li > span:last-child strong", ".registry .rules .rule-detail", ".evidence .block dt"];
  for (const cible of cibles) {
    const el = page.locator(`${RAISONNEMENT} ${cible}`).first();
    await expect(el, cible).toBeAttached();
    // ajout dans la page seulement : aucune donnée n'est modifiée
    await el.evaluate((n) => n.append(` https://exemple.test/${"identifiant".repeat(12)}`));
  }
  expect(await contenuCoupe(page, RAISONNEMENT), url).toEqual([]);
  await expectNoHorizontalOverflow(page, url);
});

test("page Méthode : playbooks entièrement lisibles", async ({ page }) => {
  await page.goto("/methode");
  await page.locator(".playbooks details").evaluateAll((els) => els.forEach((d) => ((d as HTMLDetailsElement).open = true)));
  await expect(page.locator(".playbooks table").first()).toBeVisible();
  expect(await contenuCoupe(page, ".playbooks")).toEqual([]);
  await expectNoHorizontalOverflow(page, "méthode");
});
