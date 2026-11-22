import { Client } from "pg";
import { expect, test, type TestInfo } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-052 : planchers par saison. Modèle économique écrit en base ; saisie par l'écran, lecture et écriture par l'API, bureau et mobile (390 et 360 px).
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const ECON = { origin: "DECLARED", cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, targetContributionPerNightCents: 5000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } } };

async function property(page: import("@playwright/test").Page, info: TestInfo): Promise<string> {
  const res = await page.request.post("/api/v1/properties", { data: { name: `Saisons ${uid(info)}`, city: "Lille", kind: "T2" } });
  const id = (await res.json()).id as string;
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { await c.query("update properties set status = 'ACTIVE', economics = $2::jsonb where id = $1", [id, JSON.stringify(ECON)]); } finally { await c.end(); }
  return id;
}

test("Saisons du plancher : saisie à l'écran, grille par saison, version du modèle, API", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Modèle économique écrit en base : DATABASE_URL requis.");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const id = await property(page, info);

  await page.goto(`/logements/${id}?tab=economie`);
  await expect(page.getByTestId("floor-season")).toHaveCount(0);
  await page.getByTestId("seasons-link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Saisons du plancher" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/saisons");

  // ligne invalide : montant sous le seuil de dérangement → refus lisible, rien n'est enregistré
  await page.getByLabel("Nom").first().fill("Été");
  await page.getByLabel("Du (MM-JJ)").first().fill("07-01");
  await page.getByLabel("Au inclus (MM-JJ)").first().fill("08-31");
  await page.getByLabel("Charges fixes par nuit (€)").first().fill("20");
  await page.getByRole("button", { name: "Enregistrer les saisons" }).click();
  await expect(page.getByText(/Saison « Été » : la couverture des charges fixes ne peut pas être sous le seuil/)).toBeVisible();
  expect(((await (await page.request.get(`/api/v1/properties/${id}/economics/floors`)).json()).seasons)).toEqual([]);

  // ligne valide (virgule décimale acceptée)
  await page.getByLabel("Charges fixes par nuit (€)").first().fill("60,00");
  await page.getByRole("button", { name: "Enregistrer les saisons" }).click();
  await expect(page.getByText(/Saisons enregistrées \(version 1/)).toBeVisible();

  const api = await page.request.get(`/api/v1/properties/${id}/economics/floors`);
  expect(api.headers()["cache-control"]).toContain("no-store");
  const f = await api.json();
  expect(f).toMatchObject({ complete: true, missing: [], seasons: [{ label: "Été", from: "07-01", to: "08-31", strategyContributionPerNightCents: 6000 }] });
  expect(f.grid).toHaveLength(6); // 2 canaux × 2, 7 et 28 nuits
  for (const g of f.grid) { expect(g.seasons).toHaveLength(1); expect(g.seasons[0].strategyCents).toBeGreaterThan(g.strategyCents); }

  await page.goto(`/logements/${id}?tab=economie`);
  await expect(page.getByTestId("floor-season")).toHaveCount(6);
  await expect(page.getByTestId("floor-season").first()).toContainText("Été");
  await expectNoHorizontalOverflow(page, "/economie avec saisons");

  const versions = await (await page.request.get(`/api/v1/properties/${id}/economics/versions`)).json();
  expect(versions.current).toBe(1);
  expect(versions.versions[0].changes[0]).toMatchObject({ key: "seasons.s1", label: "Saison « Été »" });

  // l'API refuse un chevauchement, une origine étrangère, l'absence de session ; une liste vide retire les saisons
  const overlap = await page.request.put(`/api/v1/properties/${id}/economics/seasons`, { data: { seasons: [{ label: "Été", from: "07-01", to: "08-31", strategyContributionPerNightCents: 6000 }, { label: "Août", from: "08-15", to: "09-15", strategyContributionPerNightCents: 6000 }] } });
  expect(overlap.status()).toBe(400);
  expect((await overlap.json()).error.message).toMatch(/se chevauchent/);
  expect((await page.request.put(`/api/v1/properties/${id}/economics/seasons`, { data: {} })).status()).toBe(400);
  expect((await page.request.put(`/api/v1/properties/${id}/economics/seasons`, { data: { seasons: [] }, headers: { origin: "https://autre-site.example" } })).status()).toBe(403);
  expect((await page.request.put(`/api/v1/properties/prop_inconnu/economics/seasons`, { data: { seasons: [] } })).status()).toBe(404);
  const cleared = await page.request.put(`/api/v1/properties/${id}/economics/seasons`, { data: { seasons: [] } });
  expect(cleared.status()).toBe(200);
  expect((await cleared.json()).version).toBe(2);
  expect((await (await page.request.get(`/api/v1/properties/${id}/economics/floors`)).json()).seasons).toEqual([]);
  expect(errors).toEqual([]);
});

test("Saisons du plancher : API refuse sans session ; le logement de démonstration ne se modifie pas", async ({ browser, baseURL, page }) => {
  const anon = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  try {
    expect((await anon.request.get("/api/v1/properties/prop_x/economics/floors")).status()).toBe(401);
    expect((await anon.request.put("/api/v1/properties/prop_x/economics/seasons", { data: { seasons: [] } })).status()).toBe(401);
  } finally { await anon.close(); }
  const list = await (await page.request.get("/api/v1/properties")).json();
  const rows = (Array.isArray(list) ? list : list.properties ?? []) as { id: string; isDemo: boolean }[];
  const demo = rows.find((p) => p.isDemo);
  if (demo) {
    expect((await page.request.put(`/api/v1/properties/${demo.id}/economics/seasons`, { data: { seasons: [] } })).status()).toBe(400);
    expect((await page.goto(`/logements/${demo.id}/saisons`))?.status()).toBe(404);
  }
});
