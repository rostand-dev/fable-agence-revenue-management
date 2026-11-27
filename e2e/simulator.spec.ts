import { Client } from "pg";
import { expect, test, type TestInfo } from "@playwright/test";
import { httpCredentials } from "./helpers/env";
import { useCreated } from "./helpers/properties";

/** supprimés après chaque test */
const toRemove = useCreated();

// US-053 : simulateur explicable (API en lecture seule). Aucun écran nouveau : le contrôle visuel de la cascade reste couvert par les tests de la fiche logement.
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const ECON = { origin: "DECLARED", cleaningFeeChargedCents: 5000, cleaningCostCents: 4000, linenCostCents: 1000, nightlyVariableCostCents: 500, hardContributionPerNightCents: 3000, strategyContributionPerNightCents: 4000, targetContributionPerNightCents: 5000, channels: { AIRBNB: { commissionPct: 15, paymentFeePct: 0 }, BOOKING: { commissionPct: 17, paymentFeePct: 1 } }, seasons: [{ id: "ete", label: "Été", from: "07-01", to: "08-31", strategyContributionPerNightCents: 6000 }] };
const STRATEGY = { basePriceCents: 12000, minPriceCents: 6000, maxPriceCents: 20000, minStay: 2, maxDiscountStackPct: 30, maxPriceChangePct: 20 };

test("Simulateur : cascade expliquée qui se referme, plancher de saison, cumul inconnu, erreurs lisibles, sans session", async ({ page, browser, baseURL }, info) => {
  test.skip(!process.env.DATABASE_URL, "Modèle économique écrit en base : DATABASE_URL requis.");
  const res = await page.request.post("/api/v1/properties", { data: { name: `Simulateur ${uid(info)}`, city: "Lille", kind: "T2" } });
  const id = toRemove.property((await res.json()).id as string);
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { await c.query("update properties set status = 'ACTIVE', economics = $2::jsonb, strategy = $3::jsonb where id = $1", [id, JSON.stringify(ECON), JSON.stringify(STRATEGY)]); } finally { await c.end(); }
  const url = (q: string) => `/api/v1/properties/${id}/simulate?${q}`;

  const ok = await page.request.get(url("channel=AIRBNB&nights=2&price=7000&from=2026-07-10"));
  expect(ok.status()).toBe(200);
  expect(ok.headers()["cache-control"]).toContain("no-store");
  const v = await ok.json();
  expect(v).toMatchObject({ reconciles: true, verdict: "WARN", floors: { hardCents: 4559, strategyCents: 8089 } });
  expect(v.floors.season.label).toBe("Été");
  const signed = v.steps.filter((s: { kind?: string }) => !s.kind).reduce((a: number, s: { cents: number }) => a + s.cents, 0);
  expect(signed).toBe(v.result.contributionCents);
  expect(v.steps.every((s: { explanation: string }) => s.explanation.length > 10)).toBe(true);
  expect((await (await page.request.get(url("channel=AIRBNB&nights=2&price=7000&from=2026-03-10"))).json()).verdict).toBe("OK");

  const human = await (await page.request.get(url("channel=BOOKING&nights=2&price=15000&promo=GENIUS:10&promo=MOBILE:5"))).json();
  expect(human.verdict).toBe("NEEDS_HUMAN");
  expect(human.reasons.find((r: { code: string }) => r.code === "STACK_RULES").detail).toContain("Règle de cumul inconnue");
  expect((await (await page.request.get(url("channel=AIRBNB&nights=2&price=3000"))).json()).verdict).toBe("REJECT");

  for (const bad of ["nights=2&price=100", "channel=AIRBNB&nights=0&price=100", "channel=AIRBNB&nights=2&price=1e3", "channel=AIRBNB&nights=2&price=100&promo=X:150"]) expect((await page.request.get(url(bad))).status(), bad).toBe(400);
  expect((await page.request.get("/api/v1/properties/prop_inconnu/simulate?channel=AIRBNB&nights=2&price=100")).status()).toBe(404);
  const anon = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, httpCredentials });
  try { expect((await anon.request.get(url("channel=AIRBNB&nights=2&price=7000"))).status()).toBe(401); } finally { await anon.close(); }
});
