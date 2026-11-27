import { Client } from "pg";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { fingerprintToken, sign } from "../src/lib/integrations/superhote-webhook";
import { encryptSecret } from "../src/lib/secret";
import { expectNoHorizontalOverflow } from "./helpers/layout";
import { useCreated } from "./helpers/properties";

/** supprimés après chaque test */
const toRemove = useCreated();

// US-030 : webhooks SuperHote. Le faux SuperHote est le test lui-même : il signe ses livraisons avec le secret qu'il a inscrit en base.
const uid = (info: TestInfo) => `${info.project.name}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const resa = (id: number, o: Record<string, unknown> = {}) => ({ id, rental_id: 7, status_label: "CONFIRMED", platform_name: "Airbnb", checkin: "2026-12-01", checkout: "2026-12-04", nights: 3, total_price: 300, host_payout: 255, host_fees: [{ type: "host_platform_commission", total: 45 }], booked_at: "2026-11-01", updated_at: "2026-11-10T10:00:00+00:00", ...o });

async function createViaApi(page: Page, name: string) {
  const res = await page.request.post("/api/v1/properties", { data: { name, city: "Lille", kind: "T2", bedrooms: 2, capacity: 4 } });
  expect(res.status(), await res.text()).toBe(201);
  return toRemove.property((await res.json()).id as string);
}
async function sql<T = any>(q: string, args: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  try { return (await c.query(q, args)).rows; } finally { await c.end(); }
}
async function linkSuperhote(propertyId: string, token: string, rentalId: string) {
  await sql("update properties set superhote = $2::jsonb where id = $1", [propertyId, JSON.stringify({ apiKeyEnc: encryptSecret(token), keyHint: "••••" + token.slice(-4), rentalId, rentalName: "Logement E2E", candidates: [] })]);
}

test("Webhooks SuperHote : signature obligatoire, idempotence, création puis annulation, panneau lisible sur tous les écrans", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL || !process.env.APP_SECRET, "Point de réception inscrit en base : DATABASE_URL et APP_SECRET requis.");
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const id = await createViaApi(page, `Webhook ${uid(info)}`);
  const token = `tok-${uid(info)}-aaaaaaaaaaaaaaaaaaaaaaaa`, secret = `whsec_${uid(info)}`, endpoint = `whk_${uid(info).replace(/[^a-z0-9]/gi, "")}`;
  await linkSuperhote(id, token, "7");
  const [{ tenant_id }] = await sql("select tenant_id from properties where id = $1", [id]);
  await sql("insert into superhote_webhooks (id, tenant_id, token_fingerprint, remote_id, secret_enc, url, events, created_by) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)", [endpoint, tenant_id, fingerprintToken(token), "1", encryptSecret(secret), `https://e2e.example/api/webhooks/superhote/${endpoint}`, JSON.stringify(["reservation.created", "reservation.updated", "reservation.canceled"]), "e2e"]);

  const url = `/api/webhooks/superhote/${endpoint}`;
  const post = async (event: string, r: Record<string, unknown>, delivery: string, key = secret) => {
    const raw = JSON.stringify({ event, delivery_id: delivery, created_at: "2026-11-10T10:00:01+00:00", data: { reservation: r } });
    return page.request.post(url, { data: raw, headers: { "content-type": "application/json", "x-superhote-signature": sign(raw, key), "x-superhote-event": event, "x-superhote-delivery": delivery } });
  };
  const rid = Math.floor(100000 + Math.random() * 800000), d = uid(info);

  // sans signature valide : refusé, rien d'inscrit
  expect((await post("reservation.created", resa(rid), "d-bad-" + d, "whsec_faux")).status()).toBe(401);
  expect((await page.request.post(url, { data: "{}", headers: { "content-type": "application/json" } })).status()).toBe(401);
  expect((await page.request.post(`/api/webhooks/superhote/whk_inconnu`, { data: "{}", headers: { "content-type": "application/json" } })).status()).toBe(404);
  expect(await sql("select 1 from webhook_deliveries where endpoint_id = $1", [endpoint])).toHaveLength(0);

  // création, nouvelle tentative identique, puis annulation par l'API (updated + CANCELED)
  const created = await post("reservation.created", resa(rid, { guest_first_name: "Camille", guest_email: "camille@example.com" }), "d-create-" + d);
  expect(created.status(), await created.text()).toBe(200); expect(await created.json()).toEqual({ received: true, status: "PROCESSED" });
  expect(await (await post("reservation.created", resa(rid), "d-create-" + d)).json()).toEqual({ received: true, duplicate: true });
  expect(await sql("select 1 from reservation_nights where property_id = $1", [id])).toHaveLength(3);
  const cancel = await post("reservation.updated", resa(rid, { status_label: "CANCELED", canceled_at: "2026-11-12T08:00:00+00:00", updated_at: "2026-11-12T08:00:00+00:00" }), "d-cancel-" + d);
  expect(await cancel.json()).toEqual({ received: true, status: "PROCESSED" });
  expect(await sql("select 1 from reservation_nights where property_id = $1", [id])).toHaveLength(0);
  const kinds = await sql("select kind from reservation_changes where property_id = $1 order by created_at", [id]);
  expect(kinds.map((k) => k.kind)).toEqual(["CREATED", "CANCELLED"]);
  const stored = await sql("select payload::text as p from webhook_deliveries where endpoint_id = $1", [endpoint]);
  expect(stored.map((r) => r.p).join(" ")).not.toMatch(/Camille|camille@|guest/);

  // le panneau d'état
  await page.goto(`/logements/${id}?tab=superhote`);
  const panel = page.getByTestId("webhook-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("actifs");
  await expect(panel).toContainText("2 traitées");
  await expect(panel.getByRole("button", { name: "Désactiver les webhooks" })).toBeVisible();
  await expectNoHorizontalOverflow(page, "/logements/:id?tab=superhote (webhooks actifs)");
  expect(errors).toEqual([]);
});

test("Webhooks SuperHote : activation refusée avec un message clair quand l'adresse n'est pas publique", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL || !process.env.APP_SECRET, "Jeton enregistré en base : DATABASE_URL et APP_SECRET requis.");
  const id = await createViaApi(page, `Webhook off ${uid(info)}`);
  const token = `tok-${uid(info)}-bbbbbbbbbbbbbbbbbbbbbbbb`;
  await linkSuperhote(id, token, "9");
  await page.goto(`/logements/${id}?tab=superhote`);
  const panel = page.getByTestId("webhook-panel");
  await expect(panel).toContainText("non activés");
  await expectNoHorizontalOverflow(page, "/logements/:id?tab=superhote (webhooks inactifs)");
  await panel.getByRole("button", { name: "Activer les webhooks" }).click();
  await expect(page.getByText(/n'est pas joignable par SuperHote/).first()).toBeVisible();
  await expectNoHorizontalOverflow(page, "/logements/:id?tab=superhote (activation refusée)");
  expect(await sql("select 1 from superhote_webhooks where token_fingerprint = $1", [fingerprintToken(token)])).toHaveLength(0);
});

test("Réconciliation SuperHote : le résumé du dernier rattrapage est lisible sur tous les écrans", async ({ page }, info) => {
  test.skip(!process.env.DATABASE_URL || !process.env.APP_SECRET, "Dernière réconciliation écrite en base : DATABASE_URL et APP_SECRET requis.");
  const id = await createViaApi(page, `Réconciliation ${uid(info)}`);
  const token = `tok-${uid(info)}-cccccccccccccccccccccccc`;
  await linkSuperhote(id, token, "11");
  await sql("update properties set superhote = superhote || $2::jsonb where id = $1", [id, JSON.stringify({ lastReconcile: { created: 2, modified: 1, cancelled: 1, vanished: 0, reactivated: 0, unchanged: 12, stale: 0, suspicious: false, at: new Date().toISOString() } })]);
  await page.goto(`/logements/${id}?tab=superhote`);
  const sum = page.getByTestId("reconcile-summary");
  await expect(sum).toContainText("2 créées");
  await expect(sum).toContainText("1 modifiée");
  await expect(sum).toContainText("1 annulée");
  await expect(sum).toContainText("écart rattrapé");
  await expectNoHorizontalOverflow(page, "/logements/:id?tab=superhote (réconciliation)");
  await sql("update properties set superhote = superhote || $2::jsonb where id = $1", [id, JSON.stringify({ lastReconcile: { created: 0, modified: 0, cancelled: 0, vanished: 0, reactivated: 0, unchanged: 14, stale: 0, suspicious: true, at: new Date().toISOString() } })]);
  await page.reload();
  await expect(page.getByTestId("reconcile-summary")).toContainText("aucun écart");
  await expect(page.getByTestId("reconcile-summary")).toContainText("lecture vide ignorée");
  await expectNoHorizontalOverflow(page, "/logements/:id?tab=superhote (lecture suspecte)");
});
