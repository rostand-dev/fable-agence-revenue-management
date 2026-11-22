import { expect, test, type Page } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-050 : KPI canoniques (API et fiche du logement), bureau, mobile 390 et 360 px, sur le logement de démonstration.
async function demoPropertyId(page: Page): Promise<string> {
  const res = await page.request.get("/api/v1/properties");
  expect(res.status()).toBe(200);
  const list = (await res.json()) as { properties?: { id: string; isDemo: boolean }[] } | { id: string; isDemo: boolean }[];
  const rows = Array.isArray(list) ? list : list.properties ?? [];
  const demo = rows.find((p) => p.isDemo) ?? rows[0];
  expect(demo, "aucun logement dans le compte de test").toBeTruthy();
  return demo.id;
}

test("API performance : KPI, détail mensuel, fenêtres à venir, valeurs inconnues à null", async ({ page }) => {
  const id = await demoPropertyId(page);
  const res = await page.request.get(`/api/v1/properties/${id}/performance`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const v = await res.json();
  expect(v).toMatchObject({ propertyId: id, currency: "EUR", period: { custom: false } });
  expect(v.monthly).toHaveLength(12);
  expect(v.horizons.map((h: { key: string }) => h.key)).toEqual(["D0_7", "D8_14", "D15_30", "D31_60", "D61_90"]);
  expect(["COMPLETE", "PARTIAL", "UNKNOWN", "NONE"]).toContain(v.kpi.netStatus);
  expect(v.kpi.availableNights).toBeGreaterThan(0);
  expect(v.kpi.occupancy).toBeGreaterThanOrEqual(0); expect(v.kpi.occupancy).toBeLessThanOrEqual(1);
  const k = v.kpi;
  if (k.soldNights > 0) expect(k.adrCents).toBe(Math.round(k.grossRoomCents / k.soldNights));
  // période libre
  const c = await page.request.get(`/api/v1/properties/${id}/performance?from=${v.period.from}&to=${v.period.to}`);
  expect(c.status()).toBe(200);
  const cv = await c.json();
  expect(cv.monthly).toBeNull(); expect(cv.kpi.grossRoomCents).toBe(k.grossRoomCents); expect(cv.kpi.soldNights).toBe(k.soldNights);
  // paramètres invalides, logement inconnu
  for (const q of ["months=0", "from=2026-01-01", "from=2026-03-01&to=2026-02-01"]) expect((await page.request.get(`/api/v1/properties/${id}/performance?${q}`)).status(), q).toBe(400);
  expect((await page.request.get("/api/v1/properties/prop_inconnu/performance")).status()).toBe(404);
});

test("API performance : refuse sans session", async ({ browser, baseURL }) => {
  const anon = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  const res = await anon.request.get("/api/v1/properties/prop_x/performance");
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  await anon.close();
});

test("fiche du logement : quatre indicateurs, période précisée, sans débordement", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const id = await demoPropertyId(page);
  await page.goto(`/logements/${id}`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  const synth = page.locator(".synth").first();
  await expect(synth).toBeVisible();
  await expect(synth).toContainText("Revenu net");
  await expect(synth).toContainText("Occupation");
  await expect(synth).toContainText("Prix moyen net");
  await expect(synth).toContainText("Revenu net par nuit disponible");
  await expect(page.locator(".kpi-note").first()).toContainText("Période");
  await expectNoHorizontalOverflow(page, "fiche logement (aperçu)");
  expect(errors, "erreurs JavaScript").toEqual([]);
});
