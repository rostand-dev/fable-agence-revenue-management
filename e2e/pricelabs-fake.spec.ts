import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-044 : le parcours PriceLabs (clé, rattachement, lecture) passe par le faux serveur de l'API PriceLabs, sans réseau ni clé réelle.
// Le scénario est choisi par la clé saisie : fake-<scénario>-<suffixe alphanumérique>.
const FAKE = (() => { try { const u = new URL(process.env.PRICELABS_API_BASE ?? ""); return u.hostname === "127.0.0.1" ? u.origin : null; } catch { return null; } })();
const suffix = (info: TestInfo) => `${info.project.name.replace(/[^a-z0-9]/gi, "")}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.padEnd(12, "0");
async function createViaApi(page: Page, name: string) {
  const res = await page.request.post("/api/v1/properties", { data: { name, city: "Châtillon", kind: "T3", bedrooms: 2, capacity: 4 } });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as string;
}
const calls = async (page: Page): Promise<{ method: string; path: string; scenario: string | null; write: boolean }[]> => (await page.request.get(`${FAKE}/__calls`)).json();

test.beforeEach(() => { test.skip(!FAKE, "Faux serveur PriceLabs : PRICELABS_API_BASE doit pointer vers 127.0.0.1."); });

test("PriceLabs (faux serveur) : clé vérifiée, rattachement confirmé, grille, marché et réservations lus, sans aucune écriture", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const id = await createViaApi(page, `PL fake ${suffix(info)}`), key = `fake-nominal-${suffix(info)}`;
  await page.goto(`/logements/${id}?tab=pricelabs`);
  await expect(page.getByText("PriceLabs n'est pas connecté à ce logement")).toBeVisible();
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (non connecté)");

  await page.getByLabel(/Clé API PriceLabs/).fill(key);
  await page.getByRole("button", { name: "Vérifier et connecter" }).click();
  await expect(page.getByText("Rattachement à confirmer")).toBeVisible();
  await expect(page.getByText("Châtillon (jeu fictif)")).toBeVisible();
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (rattachement)");

  await page.getByRole("button", { name: /rattacher/i }).click();
  await expect(page.getByText("réussie")).toBeVisible();
  await expect(page.getByText(/91 jours/).first()).toBeVisible();
  await expect(page.getByText(/120 annonces comparables/)).toBeVisible();
  await expect(page.getByText(/3 confirmées · 1 annulées ou remplacées/)).toBeVisible();
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (lu)");

  // l'onglet « 90 jours » reflète la grille lue
  await page.goto(`/logements/${id}?tab=calendrier`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoHorizontalOverflow(page, "onglet 90 jours");

  const made = await calls(page);
  expect(made.some((c) => c.scenario === "nominal" && c.path === "/listing_prices")).toBe(true);
  expect(made.filter((c) => c.write), "aucune écriture chez PriceLabs").toEqual([]);
  expect(errors).toEqual([]);
});

test("PriceLabs (faux serveur) : synchronisation désactivée chez PriceLabs, l'erreur est expliquée", async ({ page }, info) => {
  const id = await createViaApi(page, `PL off ${suffix(info)}`);
  await page.goto(`/logements/${id}?tab=pricelabs`);
  await page.getByLabel(/Clé API PriceLabs/).fill(`fake-toggle-off-${suffix(info)}`);
  await page.getByRole("button", { name: "Vérifier et connecter" }).click();
  await page.getByRole("button", { name: /rattacher/i }).click();
  await expect(page.getByText(/désactivée dans PriceLabs/).first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (erreur de lecture)");
});

test("PriceLabs (faux serveur) : clé refusée, message lisible et aucun rattachement", async ({ page }, info) => {
  const id = await createViaApi(page, `PL 401 ${suffix(info)}`);
  await page.goto(`/logements/${id}?tab=pricelabs`);
  await page.getByLabel(/Clé API PriceLabs/).fill(`fake-unauthorized-${suffix(info)}`);
  await page.getByRole("button", { name: "Vérifier et connecter" }).click();
  await expect(page.getByText(/Clé API refusée par PriceLabs/)).toBeVisible();
  await expect(page.getByText("Rattachement à confirmer")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (clé refusée)");
});

// US-040 : test de connexion (clé, annonce, prix, marché, réservations) depuis l'onglet PriceLabs, sur bureau et mobile.
async function linked(page: Page, info: TestInfo, scenario: string, label: string) {
  const id = await createViaApi(page, `PL ${label} ${suffix(info)}`);
  await page.goto(`/logements/${id}?tab=pricelabs`);
  await page.getByLabel(/Clé API PriceLabs/).fill(`fake-${scenario}-${suffix(info)}`);
  await page.getByRole("button", { name: "Vérifier et connecter" }).click();
  await page.getByRole("button", { name: /rattacher/i }).click();
  return id;
}

test("PriceLabs (faux serveur) : le test de connexion détaille ce que la clé permet de lire, sans rien écrire", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await linked(page, info, "nominal", "test ok");
  await expect(page.getByText("réussie")).toBeVisible();
  const before = (await calls(page)).length;
  await page.getByRole("button", { name: "Tester la connexion" }).click();
  const result = page.getByTestId("pricelabs-check");
  await expect(result).toBeVisible();
  await expect(result.getByText("Essentiel disponible")).toBeVisible();
  for (const label of ["Clé API", "Annonce rattachée", "Synchronisation PriceLabs", "Grille de prix", "Marché", "Réservations"]) await expect(result.getByText(label, { exact: true })).toBeVisible();
  await expect(result.getByText("disponible", { exact: true })).toHaveCount(6);
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (résultat du test)");
  const made = (await calls(page)).slice(before);
  expect(made.length).toBeGreaterThanOrEqual(4);
  expect(made.filter((c) => c.write)).toEqual([]);
  // le résultat est mémorisé : il est toujours là après rechargement
  await page.reload();
  await expect(page.getByTestId("pricelabs-check").getByText("Essentiel disponible")).toBeVisible();
  expect(errors).toEqual([]);
});

test("PriceLabs (faux serveur) : marché indisponible, le test le signale sans bloquer l'essentiel", async ({ page }, info) => {
  await linked(page, info, "market-down", "test marché");
  await page.getByRole("button", { name: "Tester la connexion" }).click();
  const result = page.getByTestId("pricelabs-check");
  await expect(result.getByText("Essentiel disponible")).toBeVisible();
  await expect(result.getByText("à vérifier", { exact: true })).toBeVisible();
  await expect(result.getByText(/Non bloquant/)).toBeVisible();
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (test avec avertissement)");
});

test("PriceLabs (faux serveur) : test de connexion avant rattachement, la clé est dite valide sans alarme", async ({ page }, info) => {
  const id = await createViaApi(page, `PL test sans annonce ${suffix(info)}`);
  await page.goto(`/logements/${id}?tab=pricelabs`);
  await page.getByLabel(/Clé API PriceLabs/).fill(`fake-nominal-${suffix(info)}`);
  await page.getByRole("button", { name: "Vérifier et connecter" }).click();
  await expect(page.getByText("Rattachement à confirmer")).toBeVisible();
  await page.getByRole("button", { name: "Tester la connexion" }).click();
  const result = page.getByTestId("pricelabs-check");
  await expect(result.getByText("Clé valide, annonce à rattacher")).toBeVisible();
  await expect(result.getByText("Lecture impossible")).toHaveCount(0);
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (test sans annonce)");
});

// US-043 : snapshots immuables, fraîcheur visible dans l'onglet et lisible par l'API, sur bureau et mobile.
test("PriceLabs (faux serveur) : fraîcheur et snapshots visibles après la lecture, sans fuite de la réponse brute", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const id = await linked(page, info, "nominal", "snapshots");
  await expect(page.getByText("réussie")).toBeVisible();
  const box = page.getByTestId("pricelabs-snapshots");
  await expect(box).toBeVisible();
  await expect(box.getByText("à jour", { exact: true })).toHaveCount(2);
  await expect(box.getByText(/Lu le .* · PriceLabs · qualité/).first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "onglet PriceLabs (fraîcheur)");

  // relecture à l'identique : le snapshot est signalé comme identique, rien n'est dupliqué
  await page.getByRole("button", { name: "Relire PriceLabs maintenant" }).click();
  await expect(page.getByTestId("pricelabs-snapshots").getByText(/identique à la lecture précédente/).first()).toBeVisible();

  const res = await page.request.get(`/api/v1/properties/${id}/snapshots`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.latest.PRICING).toMatchObject({ kind: "PRICING", source: "PRICELABS", adapter: "HTTP" });
  expect(body.freshness.PRICING.state).toBe("FRESH");
  expect(JSON.stringify(body)).not.toContain('"payload"');
  const raw = await page.request.get(`/api/v1/snapshots/${body.history.find((h: any) => !h.unchangedOf && h.kind === "PRICING").id}`);
  expect(raw.status()).toBe(200);
  expect((await raw.json()).payload).toBeTruthy();
  expect((await page.request.get(`/api/v1/snapshots/snap_inconnu`)).status()).toBe(404);
  expect((await page.request.get(`/api/v1/properties/prop_inconnu/snapshots`)).status()).toBe(404);
  expect(errors).toEqual([]);
});
