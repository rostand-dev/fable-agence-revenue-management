import http from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/db";
import { withTenant } from "@/db/tenant";
import { makeProperty, makeTenant } from "@/test/db";
import { sign } from "../integrations/superhote-webhook";
import { encryptSecret } from "../secret";
import { disableWebhook, enableWebhook, receiveWebhook, tokenFingerprint, webhookStatus } from "./superhote-webhook";

type T = Awaited<ReturnType<typeof makeTenant>>;
// faux SuperHote : crée / supprime des webhooks, enregistre ce qu'il reçoit
let server: http.Server; const calls: { method: string; url: string; auth: string; body: any }[] = []; let mode: "ok" | "403" | "422" = "ok"; let nextId = 100;
beforeAll(async () => {
  process.env.APP_SECRET = "test-secret-0123456789abcdef"; process.env.APP_URL = "https://nuitsignal.exemple.fr"; process.env.SUPERHOTE_WEBHOOK_BASE_URL = "";
  server = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization), body: b ? JSON.parse(b) : null });
      if (mode === "403") { res.statusCode = 403; return res.end("{}"); }
      if (mode === "422") { res.statusCode = 422; return res.end(JSON.stringify({ message: "limit" })); }
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") { res.statusCode = 201; return res.end(JSON.stringify({ success: true, result: { webhook: { id: ++nextId, url: "x", events: [], is_active: true }, secret: "whsec_" + nextId + "_secret" } })); }
      res.statusCode = req.url!.endsWith("/999") ? 404 : 200; res.end("");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.SUPERHOTE_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });

const TOKEN = (n: string) => `tok-${n}-aaaaaaaaaaaaaaaaaaaa`;
async function linked(t: T, name: string, token: string, rentalId: string, extra: Record<string, unknown> = {}) {
  const id = await makeProperty(t.tenantId, name);
  await db.update(schema.properties).set({ superhote: { apiKeyEnc: encryptSecret(token), keyHint: "••••" + token.slice(-4), rentalId, rentalName: name, ...extra } }).where(eq(schema.properties.id, id));
  return id;
}
const resa = (o: Record<string, unknown> = {}) => ({ id: 501, rental_id: 7, status_label: "CONFIRMED", platform_name: "Airbnb", checkin: "2026-12-01", checkout: "2026-12-04", nights: 3, total_price: 300, host_payout: 255, host_fees: [{ type: "host_platform_commission", total: 45 }], external_id: "HM1", booked_at: "2026-11-01", updated_at: "2026-11-10T10:00:00+00:00", ...o });
async function deliver(ep: { id: string; secret: string }, r: Record<string, unknown>, opts: { event?: string; delivery?: string; secret?: string; extra?: Record<string, unknown> } = {}) {
  const raw = Buffer.from(JSON.stringify({ event: opts.event ?? "reservation.created", delivery_id: opts.delivery, created_at: "2026-11-10T10:00:01+00:00", data: { reservation: r }, ...(opts.extra ?? {}) }));
  return receiveWebhook(ep.id, raw, { signature: sign(raw, opts.secret ?? ep.secret), event: opts.event ?? "reservation.created", delivery: opts.delivery ?? "dlv-" + Math.random().toString(36).slice(2) });
}
async function endpointOf(t: T, token: string) {
  const [row] = await db.select().from(schema.superhoteWebhooks).where(and(eq(schema.superhoteWebhooks.tenantId, t.tenantId), eq(schema.superhoteWebhooks.tokenFingerprint, tokenFingerprint(token))));
  return row;
}
const nights = (p: string) => db.select().from(schema.reservationNights).where(eq(schema.reservationNights.propertyId, p));
const deliveries = (t: T) => db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.tenantId, t.tenantId));

describe("activation des webhooks chez SuperHote (US-030)", () => {
  it("crée UN webhook par jeton, même pour plusieurs logements, avec le secret chiffré et l'audit", async () => {
    const t = await makeTenant("A-wh"), tok = TOKEN("a");
    const p1 = await linked(t, "Logement 1", tok, "7"), p2 = await linked(t, "Logement 2", tok, "8");
    calls.length = 0;
    expect(await enableWebhook(t.tenantId, p1, t.actor.id)).toEqual({ created: true });
    expect(await enableWebhook(t.tenantId, p2, t.actor.id)).toEqual({ created: false });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ url: "/webhooks", auth: `Bearer ${tok}` });
    expect(posts[0].body.events).toEqual(["reservation.created", "reservation.updated", "reservation.canceled"]);
    const ep = await endpointOf(t, tok);
    expect(posts[0].body.url).toBe(`https://nuitsignal.exemple.fr/api/webhooks/superhote/${ep.id}`);
    expect(ep.secretEnc).not.toContain("whsec_");
    const st = await webhookStatus(t.tenantId, p2);
    expect(st).toMatchObject({ active: true, events: ["reservation.created", "reservation.updated", "reservation.canceled"] });
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, "integration.superhote_webhook_registered")));
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0].payload)).not.toContain("whsec_");
  });
  it("deux activations simultanées : un seul webhook conservé, l'orphelin est retiré chez SuperHote", async () => {
    const t = await makeTenant("B-wh"), tok = TOKEN("b"), p = await linked(t, "Course", tok, "7");
    calls.length = 0;
    await Promise.all([enableWebhook(t.tenantId, p, "u"), enableWebhook(t.tenantId, p, "u")]);
    expect(await db.select().from(schema.superhoteWebhooks).where(eq(schema.superhoteWebhooks.tenantId, t.tenantId))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST").length - calls.filter((c) => c.method === "DELETE").length).toBe(1);
  });
  it("messages clairs : scope manquant, refus 422, logement non rattaché, jeton absent, adresse non publique", async () => {
    const t = await makeTenant("C-wh"), p = await linked(t, "Erreurs", TOKEN("c"), "7");
    mode = "403"; await expect(enableWebhook(t.tenantId, p, "u")).rejects.toThrow(/public-api:webhooks\.manage/);
    mode = "422"; await expect(enableWebhook(t.tenantId, p, "u")).rejects.toThrow(/10 webhooks/);
    mode = "ok";
    const unlinked = await linked(t, "Sans rental", TOKEN("c2"), "", { rentalId: null });
    await expect(enableWebhook(t.tenantId, unlinked, "u")).rejects.toThrow(/Rattachez/);
    const noTok = await makeProperty(t.tenantId, "Sans jeton");
    await expect(enableWebhook(t.tenantId, noTok, "u")).rejects.toThrow(/jeton/);
    process.env.APP_URL = "http://localhost:3000";
    await expect(enableWebhook(t.tenantId, p, "u")).rejects.toThrow(/joignable/);
    process.env.APP_URL = "https://nuitsignal.exemple.fr";
    expect(await db.select().from(schema.superhoteWebhooks).where(eq(schema.superhoteWebhooks.tenantId, t.tenantId))).toHaveLength(0);
  });
  it("désactivation : supprime chez SuperHote puis ici, journalise ; l'absence chez SuperHote (404) ne bloque pas", async () => {
    const t = await makeTenant("D-wh"), tok = TOKEN("d"), p = await linked(t, "À retirer", tok, "7");
    await enableWebhook(t.tenantId, p, "u");
    calls.length = 0;
    expect(await disableWebhook(t.tenantId, p, "u")).toEqual({ removed: true });
    expect(calls.map((c) => c.method)).toEqual(["DELETE"]);
    expect(await endpointOf(t, tok)).toBeUndefined();
    expect(await disableWebhook(t.tenantId, p, "u")).toEqual({ removed: false });
    await db.insert(schema.superhoteWebhooks).values({ id: "whk_gone", tenantId: t.tenantId, tokenFingerprint: tokenFingerprint(tok), remoteId: "999", secretEnc: encryptSecret("whsec_x"), url: "https://x", createdBy: "u" });
    expect(await disableWebhook(t.tenantId, p, "u")).toEqual({ removed: true });
  });
  it("supprimer le jeton d'un logement retire le webhook seulement si aucun autre logement n'utilise ce jeton", async () => {
    const { disconnectSuperhote } = await import("./superhote-sync");
    const t = await makeTenant("E-wh"), tok = TOKEN("e"), p1 = await linked(t, "L1", tok, "7"), p2 = await linked(t, "L2", tok, "8");
    await enableWebhook(t.tenantId, p1, "u");
    await disconnectSuperhote(t.tenantId, p1, "u");
    expect(await endpointOf(t, tok)).toBeDefined();
    await disconnectSuperhote(t.tenantId, p2, "u");
    expect(await endpointOf(t, tok)).toBeUndefined();
  });
});

describe("réception des livraisons", () => {
  let t: T, tok: string, prop: string, ep: { id: string; secret: string };
  beforeAll(async () => {
    t = await makeTenant("R-wh"); tok = TOKEN("r"); prop = await linked(t, "Reçoit", tok, "7");
    await enableWebhook(t.tenantId, prop, "u");
    const row = await endpointOf(t, tok); ep = { id: row.id, secret: "whsec_" + row.remoteId + "_secret" };
  });
  it("création : 200, réservation, nuits et historique WEBHOOK avec l'identifiant de livraison ; aucune donnée voyageur stockée", async () => {
    const r = await deliver(ep, resa({ guest_first_name: "Camille", guest_email: "camille@example.com" }), { delivery: "dlv-create" });
    expect(r).toEqual({ status: 200, body: { received: true, status: "PROCESSED" } });
    expect(await nights(prop)).toHaveLength(3);
    const ch = await db.select().from(schema.reservationChanges).where(eq(schema.reservationChanges.propertyId, prop));
    expect(ch[0]).toMatchObject({ kind: "CREATED", source: "WEBHOOK", deliveryId: "dlv-create" });
    const d = (await deliveries(t)).find((x) => x.deliveryId === "dlv-create")!;
    expect(d).toMatchObject({ status: "PROCESSED", outcome: "CREATED", propertyId: prop, externalId: "501", attempts: 1, event: "reservation.created" });
    expect(JSON.stringify(d.payload)).not.toMatch(/Camille|camille@|guest/);
  });
  it("idempotence : la même livraison renvoyée (nouvelle tentative) ne change rien", async () => {
    const r = await deliver(ep, resa(), { delivery: "dlv-create" });
    expect(r).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect((await deliveries(t)).filter((x) => x.deliveryId === "dlv-create")).toHaveLength(1);
    expect(await db.select().from(schema.reservationChanges).where(eq(schema.reservationChanges.propertyId, prop))).toHaveLength(1);
  });
  it("modification puis annulation via updated (status_label CANCELED) : nuits ajustées puis libérées", async () => {
    await deliver(ep, resa({ checkout: "2026-12-06", nights: 5, total_price: 500, updated_at: "2026-11-11T10:00:00+00:00" }), { event: "reservation.updated", delivery: "dlv-upd" });
    expect(await nights(prop)).toHaveLength(5);
    const c = await deliver(ep, resa({ status_label: "CANCELED", canceled_at: "2026-11-12T08:00:00+00:00", updated_at: "2026-11-12T08:00:00+00:00" }), { event: "reservation.updated", delivery: "dlv-cancel" });
    expect(c.body.status).toBe("PROCESSED");
    expect(await nights(prop)).toHaveLength(0);
    expect((await deliveries(t)).find((x) => x.deliveryId === "dlv-cancel")!.outcome).toBe("CANCELLED");
  });
  it("livraison plus ancienne que l'état connu : traitée comme STALE, rien n'est écrasé", async () => {
    const r = await deliver(ep, resa({ updated_at: "2026-11-09T00:00:00+00:00" }), { event: "reservation.updated", delivery: "dlv-old" });
    expect(r.body.status).toBe("PROCESSED");
    expect((await deliveries(t)).find((x) => x.deliveryId === "dlv-old")!.outcome).toBe("STALE");
    expect(await nights(prop)).toHaveLength(0);
  });
  it("signature invalide ou absente : 401 et rien n'est inscrit ; point inconnu : 404 ; corps trop gros : 413 ; JSON invalide : 400", async () => {
    const before = (await deliveries(t)).length;
    const raw = Buffer.from(JSON.stringify({ data: { reservation: resa() } }));
    expect((await deliver(ep, resa({ id: 777 }), { secret: "whsec_autre", delivery: "dlv-bad" })).status).toBe(401);
    expect((await receiveWebhook(ep.id, raw, { signature: null, event: "reservation.created", delivery: "d" })).status).toBe(401);
    expect((await receiveWebhook("whk_inconnu", raw, { signature: sign(raw, ep.secret), event: "reservation.created", delivery: "d" })).status).toBe(404);
    const big = Buffer.alloc(300 * 1024, "a");
    expect((await receiveWebhook(ep.id, big, { signature: sign(big, ep.secret), event: "reservation.created", delivery: "d" })).status).toBe(413);
    const junk = Buffer.from("pas du json");
    expect((await receiveWebhook(ep.id, junk, { signature: sign(junk, ep.secret), event: "reservation.created", delivery: "d" })).status).toBe(400);
    expect((await deliveries(t)).length).toBe(before);
  });
  it("logement non rattaché, autre compte SuperHote ou événement hors réservation : IGNORED, jamais d'erreur", async () => {
    const r1 = await deliver(ep, resa({ id: 888, rental_id: 4242 }), { delivery: "dlv-unmapped" });
    expect(r1.body.status).toBe("IGNORED");
    expect((await deliveries(t)).find((x) => x.deliveryId === "dlv-unmapped")).toMatchObject({ status: "IGNORED", propertyId: null });
    const other = await linked(t, "Autre compte", TOKEN("autre"), "55");
    expect((await deliver(ep, resa({ id: 889, rental_id: 55 }), { delivery: "dlv-otheracct" })).body.status).toBe("IGNORED");
    expect(await nights(other)).toHaveLength(0);
    const raw = Buffer.from(JSON.stringify({ event: "message.received", data: { message: { text: "bonjour" } } }));
    const r3 = await receiveWebhook(ep.id, raw, { signature: sign(raw, ep.secret), event: "message.received", delivery: "dlv-msg" });
    expect(r3).toEqual({ status: 200, body: { received: true, status: "IGNORED" } });
  });
  it("cloisonnement : un autre propriétaire ne voit ni l'endpoint ni les livraisons", async () => {
    const o = await makeTenant("O-wh");
    const seen = await withTenant(o.tenantId, (tx) => tx.select().from(schema.webhookDeliveries), { enforce: true });
    const seenEp = await withTenant(o.tenantId, (tx) => tx.select().from(schema.superhoteWebhooks), { enforce: true });
    expect(seen).toHaveLength(0); expect(seenEp).toHaveLength(0);
  });
  it("trois livraisons identiques simultanées : une seule est traitée", async () => {
    const same = resa({ id: 600, updated_at: "2026-11-20T10:00:00+00:00" });
    const rs = await Promise.all([1, 2, 3].map(() => deliver(ep, same, { delivery: "dlv-parallel" })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect((await deliveries(t)).filter((x) => x.deliveryId === "dlv-parallel")).toHaveLength(1);
    expect(await db.select().from(schema.reservationChanges).where(and(eq(schema.reservationChanges.propertyId, prop), eq(schema.reservationChanges.externalId, "600")))).toHaveLength(1);
  });
});

describe("échec de traitement et reprise", () => {
  it("panne transitoire : 500 à SuperHote (il réessaie), erreur générique sans SQL ni donnée personnelle ; la nouvelle tentative reprend la même livraison, une seule fois", async () => {
    const t = await makeTenant("F-wh"), tok = TOKEN("f"), prop = await linked(t, "Échec", tok, "7");
    await enableWebhook(t.tenantId, prop, "u");
    const row = await endpointOf(t, tok), ep = { id: row.id, secret: "whsec_" + row.remoteId + "_secret" };
    const spy = vi.spyOn(await import("./reservation-ingest"), "applyReservation").mockRejectedValueOnce(new Error("insert into reservations values ($1) camille@example.com"));
    const r = await deliver(ep, resa(), { delivery: "dlv-fail" });
    spy.mockRestore();
    expect(r).toEqual({ status: 500, body: { received: true, status: "FAILED", retry: true } });
    const d1 = (await deliveries(t)).find((x) => x.deliveryId === "dlv-fail")!;
    expect(d1).toMatchObject({ status: "FAILED", attempts: 1, claimedAt: null });
    expect(d1.error).toMatch(/erreur technique/);
    expect(d1.error).not.toMatch(/insert|camille/);
    expect(await nights(prop)).toHaveLength(0);
    const retry = await deliver(ep, resa(), { delivery: "dlv-fail" }); // SuperHote réessaie : même identifiant de livraison
    expect(retry).toEqual({ status: 200, body: { received: true, status: "PROCESSED" } });
    expect((await deliveries(t)).filter((x) => x.deliveryId === "dlv-fail")).toHaveLength(1);
    expect((await deliveries(t)).find((x) => x.deliveryId === "dlv-fail")).toMatchObject({ status: "PROCESSED", outcome: "CREATED", attempts: 2 });
    expect(await nights(prop)).toHaveLength(3);
    expect((await deliver(ep, resa(), { delivery: "dlv-fail" })).body).toEqual({ received: true, duplicate: true });
  });
  it("après 3 tentatives en échec : 200 (SuperHote cesse), la livraison reste FAILED et n'est plus reprise sauf rejeu forcé", async () => {
    const { processDelivery } = await import("./superhote-webhook");
    const t = await makeTenant("G-wh"), tok = TOKEN("g"), prop = await linked(t, "Abandon", tok, "7");
    await enableWebhook(t.tenantId, prop, "u");
    const row = await endpointOf(t, tok), ep = { id: row.id, secret: "whsec_" + row.remoteId + "_secret" };
    const ingest = await import("./reservation-ingest");
    const spy = vi.spyOn(ingest, "applyReservation").mockRejectedValue(new Error("panne"));
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await deliver(ep, resa(), { delivery: "dlv-giveup" })).status);
    expect(codes).toEqual([500, 500, 200, 200]);
    const d = (await deliveries(t)).find((x) => x.deliveryId === "dlv-giveup")!;
    expect(d).toMatchObject({ status: "FAILED", attempts: 3 });
    spy.mockRestore();
    expect((await processDelivery(t.tenantId, d.id)).status).toBe("SKIPPED");
    expect((await processDelivery(t.tenantId, d.id, { force: true })).status).toBe("PROCESSED");
    expect(await nights(prop)).toHaveLength(3);
  });
  it("traitements simultanés d'une même livraison : un seul traite, le résultat n'est pas écrasé", async () => {
    const t = await makeTenant("H-wh"), tok = TOKEN("h"), prop = await linked(t, "Course", tok, "7");
    await enableWebhook(t.tenantId, prop, "u");
    const row = await endpointOf(t, tok), ep = { id: row.id, secret: "whsec_" + row.remoteId + "_secret" };
    await Promise.all([1, 2, 3, 4].map(() => deliver(ep, resa(), { delivery: "dlv-race" })));
    const d = (await deliveries(t)).filter((x) => x.deliveryId === "dlv-race");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: "PROCESSED", outcome: "CREATED", attempts: 1 });
  });
  it("une livraison réclamée depuis plus d'une minute (traitement interrompu) est reprise", async () => {
    const t = await makeTenant("I-wh"), tok = TOKEN("i"), prop = await linked(t, "Interrompu", tok, "7");
    await enableWebhook(t.tenantId, prop, "u");
    const row = await endpointOf(t, tok), ep = { id: row.id, secret: "whsec_" + row.remoteId + "_secret" };
    await deliver(ep, resa({ id: 321 }), { delivery: "dlv-stuck" });
    await db.update(schema.webhookDeliveries).set({ status: "PROCESSING", claimedAt: new Date(Date.now() - 120_000), outcome: null }).where(eq(schema.webhookDeliveries.deliveryId, "dlv-stuck"));
    expect((await deliver(ep, resa({ id: 321 }), { delivery: "dlv-stuck" })).body.status).toBe("PROCESSED");
    await db.update(schema.webhookDeliveries).set({ status: "PROCESSING", claimedAt: new Date() }).where(eq(schema.webhookDeliveries.deliveryId, "dlv-stuck"));
    expect((await deliver(ep, resa({ id: 321 }), { delivery: "dlv-stuck" })).body).toEqual({ received: true, duplicate: true }); // encore en cours ailleurs
  });
});

describe("cycle de vie du point de réception", () => {
  it("désactiver conserve l'historique des livraisons (endpoint_id mis à null)", async () => {
    const t = await makeTenant("J-wh"), tok = TOKEN("j"), prop = await linked(t, "Historique", tok, "7");
    await enableWebhook(t.tenantId, prop, "u");
    const row = await endpointOf(t, tok), ep = { id: row.id, secret: "whsec_" + row.remoteId + "_secret" };
    await deliver(ep, resa(), { delivery: "dlv-keep" });
    await disableWebhook(t.tenantId, prop, "u");
    const d = (await deliveries(t)).find((x) => x.deliveryId === "dlv-keep")!;
    expect(d).toMatchObject({ status: "PROCESSED", endpointId: null });
  });
  it("si SuperHote refuse la suppression (droits), le point de réception est conservé et l'écart est consigné", async () => {
    const { cleanupWebhookForToken } = await import("./superhote-webhook");
    const t = await makeTenant("K-wh"), tok = TOKEN("k"), prop = await linked(t, "Droits", tok, "7");
    await enableWebhook(t.tenantId, prop, "u");
    mode = "403";
    await cleanupWebhookForToken(t.tenantId, tok, prop);
    mode = "ok";
    expect(await endpointOf(t, tok)).toBeDefined();
    const ev = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, "integration.superhote_webhook_removed")));
    expect(ev).toHaveLength(1);
  });
  it("activation refusée sur une instance protégée par mot de passe (Preview)", async () => {
    const t = await makeTenant("L-wh"), prop = await linked(t, "Preview", TOKEN("l"), "7");
    process.env.PREVIEW_BASIC_AUTH_USER = "u"; process.env.PREVIEW_BASIC_AUTH_PASSWORD = "mot-de-passe-assez-long";
    try { await expect(enableWebhook(t.tenantId, prop, "u")).rejects.toThrow(/protégée par un mot de passe/); }
    finally { delete process.env.PREVIEW_BASIC_AUTH_USER; delete process.env.PREVIEW_BASIC_AUTH_PASSWORD; }
  });
});

describe("route HTTP", () => {
  it("corps fragmenté sans content-length au-delà de 256 Ko : 413 sans tout charger ; signature absente : 401", async () => {
    const { POST } = await import("@/app/api/webhooks/superhote/[endpointId]/route");
    const chunk = new Uint8Array(64 * 1024).fill(97);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= 40) return c.close(); sent++; c.enqueue(chunk); } });
    const big = new Request("http://x/api/webhooks/superhote/whk_x", { method: "POST", body: stream, duplex: "half" } as any);
    expect(big.headers.get("content-length")).toBeNull();
    const r = await POST(big, { params: Promise.resolve({ endpointId: "whk_x" }) });
    expect(r.status).toBe(413);
    expect(sent).toBeLessThan(10); // lecture interrompue dès la limite franchie
    const small = new Request("http://x/api/webhooks/superhote/whk_x", { method: "POST", body: "{}" });
    expect((await POST(small, { params: Promise.resolve({ endpointId: "whk_x" }) })).status).toBe(404);
  });
});
