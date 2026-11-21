import { Client } from "pg";
import { expect, test, type TestInfo } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { expectNoHorizontalOverflow } from "./helpers/layout";

// US-024 : checklist de qualité bloquant l'activation. Logement créé par l'API puis mis « en observation » en base. Trois formats d'écran.
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const ECON = { cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, channels: { AIRBNB: { commissionPct: 15.5, paymentFeePct: 0 } } };

test("Checklist de qualité : activation bloquée tant que le mapping n'est pas confirmé, puis activation, API", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Logement mis en observation en base : DATABASE_URL requis.");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.request.post("/api/v1/properties", { data: { name: `Qualité ${uid(info)}`, city: "Lille", kind: "T2", bedrooms: 2 } });
  const id = (await res.json()).id as string;
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try {
    const pl = { apiKeyEnc: "x", listingId: "pl1", pms: "superhote", listingName: "Annonce", candidates: [{ id: "pl1", pms: "superhote", name: "Annonce", city: "Lille", bedrooms: 2 }], lastSync: { ok: true, at: new Date().toISOString(), days: 90 } };
    await c.query("update properties set status = 'SHADOW', economics = $2::jsonb, strategy = $3::jsonb, pricelabs = $4::jsonb where id = $1", [id, JSON.stringify(ECON), JSON.stringify({ basePriceCents: 12000, minPriceCents: 8000, maxPriceCents: 20000, minStay: 2 }), JSON.stringify(pl)]);
  } finally { await c.end(); }

  // API : un seul point bloquant, pas activable ; l'activation est refusée
  const q0 = await (await page.request.get(`/api/v1/properties/${id}/quality`)).json();
  expect(q0).toMatchObject({ status: "SHADOW", canActivate: false, blockers: ["mapping"] });
  const refused = await page.request.post(`/api/v1/properties/${id}/activate`);
  expect(refused.status()).toBe(400);
  expect((await refused.json()).error.message).toContain("Mapping des identifiants confirmé");

  expect((await page.request.get("/api/v1/properties/inconnu/quality")).status()).toBe(404);

  // page : point bloquant visible, bouton indisponible, pas de débordement
  await page.goto(`/logements/${id}`);
  await page.getByRole("link", { name: "Checklist de qualité" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Checklist de qualité" })).toBeVisible();
  await expect(page.getByTestId("quality-status")).toContainText("1 point bloquant");
  await expect(page.getByTestId("quality-mapping")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("quality-pricelabs")).toHaveAttribute("data-ok", "true");
  await expect(page.getByRole("button", { name: /Activer le logement/ })).toBeDisabled();
  await expectNoHorizontalOverflow(page, "/qualite bloquée");

  // correction : confirmation du mapping depuis le lien proposé
  await page.getByRole("link", { name: "Confirmer le mapping" }).click();
  await page.getByRole("button", { name: /Confirmer le mapping/ }).click();
  await expect(page.getByTestId("mapping-status")).toContainText("confirmé");
  await page.goto(`/logements/${id}/qualite`);
  await expect(page.getByTestId("quality-status")).toContainText("checklist satisfaite");
  await expect(page.getByTestId("quality-superhote")).toHaveAttribute("data-ok", "false"); // avertissement seulement
  await expectNoHorizontalOverflow(page, "/qualite satisfaite");

  // activation
  await page.getByRole("button", { name: "Activer le logement" }).click();
  await expect(page.getByText("Ce logement est actif.")).toBeVisible();
  await expect(page.getByTestId("quality-status")).toContainText("Actif");
  const q1 = await (await page.request.get(`/api/v1/properties/${id}/quality`)).json();
  expect(q1.status).toBe("ACTIVE");
  const again = await page.request.post(`/api/v1/properties/${id}/activate`);
  expect(again.status()).toBe(400);
  expect((await again.json()).error.message).toContain("déjà actif");
  expect(errors).toEqual([]);
});

test("Checklist de qualité : API sans session refusée", async ({ browser, baseURL }) => {
  const anon = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  for (const [m, p] of [["get", "/api/v1/properties/x/quality"], ["post", "/api/v1/properties/x/activate"]] as const) {
    const r = await (anon.request as any)[m](p, m === "post" ? { data: {} } : undefined);
    expect(r.status(), `${m} ${p}`).toBe(401);
  }
  await anon.close();
});
