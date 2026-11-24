import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { withApprovedManualDossier } from "./helpers/dossier";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { hasDatabase } from "./helpers/roles";

// US-104 : période de repos visible au registre, expiration sans repos, seconde relecture d'une action confirmée à la main. Trois largeurs, sans débordement.
test.skip(!hasDatabase(), "DATABASE_URL absent : données de test non créables sur cet environnement");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
const shift = (n: number) => new Date(Date.parse(today() + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10); // jours de Paris, jamais ceux de la base
const tag = () => test.info().project.name.replace(/\W/g, "") + Date.now().toString(36);

async function premierLogementId(page: Page): Promise<string> {
  await page.goto("/logements");
  const hrefs = await page.locator('a[href^="/logements/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!).filter((h) => /^\/logements\/[^/]+$/.test(h) && !h.endsWith("/nouveau")));
  expect(hrefs.length, "aucun logement dans la démonstration").toBeGreaterThan(0);
  return hrefs[0];
}

test("Registre : une fin manuelle ouvre une période de repos visible ; une expiration naturelle n'en ouvre pas", async ({ page }) => {
  const href = await premierLogementId(page);
  const propId = href.split("/").pop()!;
  const t = tag(), manual = `Mobile fin manuelle ${t}`, expired = `Mobile expirée ${t}`;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const p = await c.query(`select tenant_id from properties where id = $1`, [propId]);
    const tenant = p.rows[0].tenant_id;
    const ins = (id: string, label: string, kind: string, reason: string) => c.query(
      `insert into promotions (id, tenant_id, property_id, channel, kind, label, discount_pct, status, source, ended_at, end_reason, stay_from, stay_to) values ($1,$2,$3,'AIRBNB',$4,$5,5,'ENDED','MANUAL', now(), $6, $7::date, $8::date)`, [id, tenant, propId, kind, label, reason, shift(-30), shift(-1)]);
    await ins(`e2e-m-${t}`, manual, "LAST_MINUTE", "Arrêtée à la main");
    await ins(`e2e-e-${t}`, expired, "EARLY_BIRD", "Expirée : séjours terminés");
    await page.goto(`${href}?tab=canaux`);
    const registry = page.getByTestId("promo-registry");
    await expect(registry).toBeVisible();
    await registry.locator("details.fold > summary", { hasText: "Promotions terminées" }).click();
    const cardOf = (label: string) => registry.locator("article", { hasText: label });
    await cardOf(manual).scrollIntoViewIfNeeded();
    await expect(cardOf(manual).getByTestId("promo-repos")).toContainText("Période de repos jusqu'au");
    await expect(cardOf(expired)).toBeVisible();
    await expect(cardOf(expired).getByTestId("promo-repos")).toHaveCount(0);
    await expectNoHorizontalOverflow(page, "registre avec période de repos");
  } finally {
    await c.query(`delete from promotions where id in ($1,$2)`, [`e2e-m-${t}`, `e2e-e-${t}`]).catch(() => {});
    await c.end();
  }
});

test("Seconde relecture : la personne qui a confirmé ne peut pas relire tout de suite", async ({ page }) => {
  await withApprovedManualDossier(async (code) => {
    await page.goto(`/dossier/${code}`);
    await page.getByLabel(/Portée réellement appliquée/).fill("Promotion retirée dans l'extranet pour les dates du dossier");
    await page.getByLabel(/Date d'entrée en vigueur/).fill(today());
    await page.getByLabel(/Identifiant dans l'extranet/).fill("BK-CYC-7");
    await page.getByRole("button", { name: "Déclarer la réalisation" }).click();
    const rule = page.getByTestId("regle-relecture");
    await expect(rule).toContainText("Vous avez confirmé cette action");
    await rule.scrollIntoViewIfNeeded();
    await expectNoHorizontalOverflow(page, "règle de seconde relecture");
    await page.getByRole("button", { name: "Confirmer la relecture" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "autre personne" })).toBeVisible();
    // l'action n'a pas avancé : la relecture reste proposée
    await expect(page.getByRole("button", { name: "Confirmer la relecture" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "refus de relecture");
  });
});
