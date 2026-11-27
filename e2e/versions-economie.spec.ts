import { Client } from "pg";
import { expect, test, type TestInfo } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";
import { useCreated } from "./helpers/properties";

/** supprimés après chaque test */
const toRemove = useCreated();

// écrans réservés à l'ordinateur : testés en version complète à toutes les largeurs
test.use(VERSION_COMPLETE);

// US-022 : historique du modèle économique. Les versions sont écrites en base (la saisie des coûts est couverte par les tests d'intégration) ; l'écran et l'API sont testés sur les trois formats.
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test("Versions du modèle économique : liste, détail des changements, lien depuis l'économie, API", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL, "Versions écrites en base : DATABASE_URL requis.");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const res = await page.request.post("/api/v1/properties", { data: { name: `Versions ${uid(info)}`, city: "Lille", kind: "T2" } });
  const id = toRemove.property((await res.json()).id as string);
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try {
    const { rows: [pr] } = await c.query("select tenant_id from properties where id = $1", [id]);
    const ins = (v: number, by: string, changes: unknown[]) => c.query("insert into economic_model_versions (id, tenant_id, property_id, version, model, changes, created_by) values ($1,$2,$3,$4,'{}'::jsonb,$5::jsonb,$6)", [`ecv_e2e_${id}_${v}`, pr.tenant_id, id, v, JSON.stringify(changes), by]);
    await ins(1, "system", []);
    await ins(2, "system", [{ key: "channels.BOOKING.commissionPct", label: "Commission Booking.com", from: "15 %", to: "17 %" }, { key: "cleaningCostCents", label: "Coût du ménage", from: null, to: "45,00 €" }]);
    await c.query("update properties set status = 'ACTIVE', economics_version = 2 where id = $1", [id]);
  } finally { await c.end(); }
  await page.goto(`/logements/${id}?tab=economie`);
  await page.getByRole("link", { name: /Versions du modèle économique/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Versions du modèle économique" })).toBeVisible();
  const cards = page.getByTestId("economics-version");
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText("Version 2");
  await expect(cards.first()).toContainText("en vigueur");
  await expect(cards.first()).toContainText("15 %");
  await expect(cards.first()).toContainText("inconnue"); // une valeur inconnue se lit « inconnue », pas « 0 »
  await expect(cards.nth(1)).toContainText("ancienne");
  await expectNoHorizontalOverflow(page, "/versions-economie");
  const api = await page.request.get(`/api/v1/properties/${id}/economics/versions`);
  const body = await api.json();
  expect(body.current).toBe(2);
  expect(body.versions.map((v: any) => v.version)).toEqual([2, 1]);
  expect((await page.request.get(`/api/v1/properties/prop_inexistant/economics/versions`)).status()).toBe(404);
  expect(errors).toEqual([]);
});
