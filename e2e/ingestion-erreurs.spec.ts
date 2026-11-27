import { Client } from "pg";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { fingerprintToken } from "../src/lib/integrations/superhote-webhook";
import { encryptSecret } from "../src/lib/secret";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { VERSION_COMPLETE } from "./helpers/view";
import { useCreated } from "./helpers/properties";

/** supprimés après chaque test */
const toRemove = useCreated();

// écrans réservés à l'ordinateur : testés en version complète à toutes les largeurs
test.use(VERSION_COMPLETE);

// US-033 : écran des erreurs d'ingestion SuperHote. Les livraisons en échec sont inscrites en base ; le test les rejoue et les écarte depuis l'écran.
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const resa = (id: number, o: Record<string, unknown> = {}) => ({ id, rental_id: 7, status_label: "CONFIRMED", platform_name: "Airbnb", checkin: "2026-12-01", checkout: "2026-12-04", nights: 3, total_price: 300, host_payout: 255, host_fees: [{ type: "host_platform_commission", total: 45 }], booked_at: "2026-11-01", updated_at: "2026-11-10T10:00:00+00:00", ...o });
async function sql<T = any>(q: string, args: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { return (await c.query(q, args)).rows; } finally { await c.end(); }
}
async function createViaApi(page: Page, name: string) {
  const res = await page.request.post("/api/v1/properties", { data: { name, city: "Lille", kind: "T2", bedrooms: 2, capacity: 4 } });
  expect(res.status(), await res.text()).toBe(201);
  return toRemove.property((await res.json()).id as string);
}

test("Erreurs d'ingestion : rejeu, mise à l'écart et lectures en échec, lisibles sur tous les écrans", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL || !process.env.APP_SECRET, "Livraisons inscrites en base : DATABASE_URL et APP_SECRET requis.");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const u = uid(info).replace(/[^a-z0-9]/gi, "");
  const id = await createViaApi(page, `Erreurs ${u}`);
  const token = `tok-${u}-aaaaaaaaaaaaaaaaaaaaaaaa`, endpoint = `whk_${u}`;
  await sql("update properties set superhote = $2::jsonb where id = $1", [id, JSON.stringify({ apiKeyEnc: encryptSecret(token), keyHint: "••••" + token.slice(-4), rentalId: "7", rentalName: "Logement E2E", candidates: [], lastSync: { ok: false, at: new Date().toISOString(), error: `Lecture SuperHote incomplète (${u})` } })]);
  const [{ tenant_id }] = await sql("select tenant_id from properties where id = $1", [id]);
  await sql("insert into superhote_webhooks (id, tenant_id, token_fingerprint, remote_id, secret_enc, url, events, created_by) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)", [endpoint, tenant_id, fingerprintToken(token), "1", encryptSecret("whsec_e2e"), `https://e2e.example/api/webhooks/superhote/${endpoint}`, "[]", "e2e"]);
  const seed = (key: string, ext: string, payload: Record<string, unknown>, attempts: number, error: string) =>
    sql("insert into webhook_deliveries (id, tenant_id, endpoint_id, delivery_id, event, external_id, status, attempts, error, payload) values ($1,$2,$3,$4,'reservation.created',$5,'FAILED',$6,$7,$8::jsonb)", [`dl_${u}${key}`, tenant_id, endpoint, `dlv-${u}-${key}`, ext, attempts, error, JSON.stringify(payload)]);
  const rid = Math.floor(100000 + Math.random() * 800000);
  await seed("a", `E${rid}1`, resa(rid), 3, "Écriture impossible (erreur technique)");
  await seed("b", `E${rid}2`, resa(rid + 1, { checkin: "2027-03-01", checkout: "2027-03-03", nights: 2 }), 1, "Panne passagère (e2e)");
  await seed("c", `E${rid}3`, { id: "illisible" }, 1, "Charge utile illisible (e2e)");

  await page.goto("/integrations");
  await expect(page.getByTestId("ingestion-link")).toContainText(/[1-9]\d* à traiter/);
  await page.getByTestId("ingestion-link").getByRole("link").click();
  await expect(page).toHaveURL(/\/integrations\/erreurs/);

  const card = (ext: string) => page.getByTestId("delivery").filter({ hasText: ext });
  await expect(card(`E${rid}1`)).toContainText("Abandonnée");
  await expect(card(`E${rid}2`)).toContainText("En échec");
  await expect(card(`E${rid}2`)).toContainText("Panne passagère (e2e)");
  await expect(page.getByTestId("read-failures")).toContainText(`Lecture SuperHote incomplète (${u})`);
  await expectNoHorizontalOverflow(page, "/integrations/erreurs (échecs)");

  // rejeu d'une livraison abandonnée : la réservation est créée, la carte disparaît
  await card(`E${rid}1`).getByRole("button", { name: "Rejouer" }).click();
  await expect(card(`E${rid}1`)).toHaveCount(0);
  expect(await sql("select status from webhook_deliveries where id = $1", [`dl_${u}a`])).toEqual([{ status: "PROCESSED" }]);
  expect(await sql("select 1 from reservation_nights where property_id = $1", [id])).toHaveLength(3);

  // mise à l'écart
  await card(`E${rid}2`).getByRole("button", { name: "Écarter" }).click();
  await expect(card(`E${rid}2`)).toHaveCount(0);
  expect(await sql("select status, outcome from webhook_deliveries where id = $1", [`dl_${u}b`])).toEqual([{ status: "IGNORED", outcome: "Écartée par le propriétaire" }]);

  // un rejeu qui échoue encore reste visible, avec sa raison
  await card(`E${rid}3`).getByRole("button", { name: "Rejouer" }).click();
  await expect.poll(async () => (await sql("select status, attempts from webhook_deliveries where id = $1", [`dl_${u}c`]))[0]).toEqual({ status: "FAILED", attempts: 2 });
  await expect(card(`E${rid}3`)).toContainText("Charge utile illisible");
  await expectNoHorizontalOverflow(page, "/integrations/erreurs (après actions)");

  // lecture rétablie : la section des lectures en échec disparaît
  await sql("update properties set superhote = superhote || $2::jsonb where id = $1", [id, JSON.stringify({ lastSync: { ok: true, at: new Date().toISOString() } })]);
  await page.reload();
  await expect(page.getByTestId("read-failures").filter({ hasText: `Lecture SuperHote incomplète (${u})` })).toHaveCount(0);
  expect(errors).toEqual([]);
});
