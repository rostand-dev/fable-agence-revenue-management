import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-101 : compilateur de promotions : une intention devient une promotion par canal, ou un refus expliqué. Lecture seule : aucune donnée écrite.
// Lisible sans défilement horizontal sur bureau, 390 px et 360 px.
async function premierLogement(page: Page): Promise<string> {
  await page.goto("/logements");
  const hrefs = await page.locator('.content a[href^="/logements/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!).filter((h) => /^\/logements\/[^/]+$/.test(h) && !h.endsWith("/nouveau")));
  expect(hrefs.length, "aucun logement dans la démonstration").toBeGreaterThan(0);
  return hrefs[0];
}
const paris = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
const iso = (n: number) => new Date(Date.parse(paris() + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);

test("Compilateur : accès depuis le registre, intention de longs séjours, refus expliqué sur Booking.com", async ({ page }) => {
  const href = await premierLogement(page);
  await page.goto(`${href}?tab=canaux`);
  await page.getByTestId("open-compiler").click();
  await expect(page).toHaveURL(/\/compilateur$/);
  await expect(page.getByRole("heading", { name: "Compilateur de promotions", level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page, "compilateur vide");

  await page.getByLabel(/Intention/).selectOption("STIMULATE_LONG_STAY");
  await page.getByLabel(/Séjours à partir du/).fill(iso(30));
  await page.getByLabel(/Séjours jusqu'au/).fill(iso(60));
  await page.getByLabel("Prix publié par nuit sur Airbnb").fill("180");
  await page.getByLabel("Prix publié par nuit sur Booking.com").fill("190");
  await page.getByRole("button", { name: "Compiler" }).click();

  const result = page.getByTestId("compile-result");
  await expect(result).toBeVisible();
  const booking = page.getByTestId("compile-BOOKING");
  await expect(booking).toHaveAttribute("data-status", "NO_SAFE_EQUIVALENT");
  await expect(booking).toContainText("Aucun équivalent sûr");
  await expect(booking).toContainText("registre de cumul");
  const airbnb = page.getByTestId("compile-AIRBNB");
  await expect(airbnb).toBeVisible();
  await expect(result.getByText(/Côté PriceLabs/)).toBeVisible();
  await expectNoHorizontalOverflow(page, "résultat du compilateur");
});

test("Compilateur : demande proche, chaque canal a son verdict et la saisie invalide est expliquée", async ({ page }) => {
  const href = await premierLogement(page);
  const q = new URLSearchParams({ intent: "STIMULATE_NEAR_TERM_DEMAND", stayFrom: iso(10), stayTo: iso(20), maxDiscountPct: "10", channel_AIRBNB: "on", channel_BOOKING: "on", price_AIRBNB: "200", price_BOOKING: "200" });
  await page.goto(`${href}/compilateur?${q}`);
  for (const c of ["AIRBNB", "BOOKING"]) {
    const card = page.getByTestId(`compile-${c}`);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-status", /^(COMPILED|NEEDS_HUMAN|NO_SAFE_EQUIVALENT)$/);
  }
  // au moins une promotion proposée : on ouvre sa cascade (le composant le plus large) et on contrôle le débordement
  const proposed = page.locator('[data-testid^="compile-"][data-status="COMPILED"], [data-testid^="compile-"][data-status="NEEDS_HUMAN"]').first();
  await expect(proposed).toBeVisible();
  await proposed.getByText("Voir la cascade du revenu").click();
  await expect(proposed.getByTestId("waterfall")).toBeVisible();
  await expectNoHorizontalOverflow(page, "cascade ouverte");
  await expectNoHorizontalOverflow(page, "demande proche");

  q.set("price_BOOKING", "");
  await page.goto(`${href}/compilateur?${q}`);
  await expect(page.getByText(/prix publié par nuit sur Booking\.com/)).toBeVisible();
  q.set("price_BOOKING", "200");
  q.set("maxDiscountPct", "95");
  await page.goto(`${href}/compilateur?${q}`);
  await expect(page.getByText("Saisie à corriger")).toBeVisible();
  await expect(page.getByText(/entre 1 et 80/)).toBeVisible();
  await expect(page.getByTestId("compile-result")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "saisie invalide");
});
