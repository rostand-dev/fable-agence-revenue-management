import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db";
import { makeProperty, makeTenant } from "@/test/db";
import { encryptSecret } from "../secret";
import { dismissDelivery, ingestionErrorCount, listIngestionErrors, replayAll, replayDelivery } from "./ingestion-errors";
import { tokenFingerprint } from "./superhote-webhook";

type T = Awaited<ReturnType<typeof makeTenant>>;
beforeAll(() => { process.env.APP_SECRET = "test-secret-0123456789abcdef"; });
const TOKEN = (n: string) => `tok-${n}-aaaaaaaaaaaaaaaaaaaa`;
const resa = (o: Record<string, unknown> = {}) => ({ id: 501, rental_id: 7, status_label: "CONFIRMED", platform_name: "Airbnb", checkin: "2026-12-01", checkout: "2026-12-04", nights: 3, total_price: 300, host_payout: 255, host_fees: [{ type: "host_platform_commission", total: 45 }], external_id: "HM1", booked_at: "2026-11-01", updated_at: "2026-11-10T10:00:00+00:00", ...o });

async function setup(label: string) {
  const t = await makeTenant(label), tok = TOKEN(label);
  const prop = await makeProperty(t.tenantId, "Logement " + label);
  await db.update(schema.properties).set({ superhote: { apiKeyEnc: encryptSecret(tok), keyHint: "••••", rentalId: "7", rentalName: "L" } }).where(eq(schema.properties.id, prop));
  const [ep] = await db.insert(schema.superhoteWebhooks).values({ id: "whk_" + Math.random().toString(36).slice(2, 12), tenantId: t.tenantId, tokenFingerprint: tokenFingerprint(tok), remoteId: "1", secretEnc: encryptSecret("whsec_x"), url: "https://x.example/api/webhooks/superhote/x", events: [], createdBy: "test" }).returning();
  return { t, prop, ep };
}
async function failed(t: T, ep: { id: string } | null, o: Partial<typeof schema.webhookDeliveries.$inferInsert> = {}) {
  const [d] = await db.insert(schema.webhookDeliveries).values({ id: "dl_" + Math.random().toString(36).slice(2, 12), tenantId: t.tenantId, endpointId: ep?.id ?? null, deliveryId: "dlv-" + Math.random().toString(36).slice(2), event: "reservation.created", externalId: "501", status: "FAILED", attempts: 1, error: "Écriture impossible", payload: resa(), ...o }).returning();
  return d;
}
const row = async (id: string) => (await db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.id, id)))[0];
const audits = (t: T, type: string) => db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.tenantId, t.tenantId), eq(schema.auditEvents.type, type)));

describe("file des échecs d'ingestion (US-033)", () => {
  it("liste les échecs, distingue attente, abandon et interruption, ignore les livraisons saines", async () => {
    const { t, ep } = await setup("list");
    await failed(t, ep, { attempts: 1 });
    await failed(t, ep, { attempts: 3 });
    await failed(t, ep, { status: "PROCESSING", claimedAt: new Date(Date.now() - 5 * 60_000) });
    await failed(t, ep, { status: "PROCESSING", claimedAt: new Date() }); // en cours, pas bloquée
    await failed(t, ep, { status: "PROCESSED", error: null, outcome: "CREATED" });
    const e = await listIngestionErrors(t.tenantId);
    expect(e.total).toBe(3);
    expect(e.abandoned).toBe(1);
    expect(e.deliveries.map((d) => d.stage).sort()).toEqual(["abandoned", "failed", "interrupted"]);
    expect(await ingestionErrorCount(t.tenantId)).toBe(3);
  });

  it("remonte les lectures planifiées en échec et les lectures suspectes", async () => {
    const { t, prop } = await setup("reads");
    const [sh] = (await db.select({ sh: schema.properties.superhote }).from(schema.properties).where(eq(schema.properties.id, prop))).map((r) => r.sh!);
    await db.update(schema.properties).set({ superhote: { ...sh, lastSync: { ok: false, at: new Date().toISOString(), error: "Lecture SuperHote incomplète" } } }).where(eq(schema.properties.id, prop));
    expect((await listIngestionErrors(t.tenantId)).readFailures).toMatchObject([{ propertyId: prop, kind: "READ" }]);
    await db.update(schema.properties).set({ superhote: { ...sh, lastSync: { ok: true, at: new Date().toISOString() }, lastReconcile: { suspicious: true, at: new Date().toISOString() } } as any }).where(eq(schema.properties.id, prop));
    expect((await listIngestionErrors(t.tenantId)).readFailures).toMatchObject([{ kind: "SUSPICIOUS" }]);
  });

  it("rejoue une livraison en échec : la réservation est créée, la livraison passe PROCESSED, l'audit est écrit", async () => {
    const { t, prop, ep } = await setup("replay");
    const d = await failed(t, ep);
    const r = await replayDelivery(t.tenantId, t.actor.id, d.id);
    expect(r.status).toBe("PROCESSED");
    expect((await row(d.id)).status).toBe("PROCESSED");
    expect(await db.select().from(schema.reservationNights).where(eq(schema.reservationNights.propertyId, prop))).toHaveLength(3);
    expect(await audits(t, "integration.webhook_replayed")).toHaveLength(1);
    expect((await listIngestionErrors(t.tenantId)).total).toBe(0);
  });

  it("rejoue même une livraison abandonnée (au-delà des tentatives automatiques) sans doublon", async () => {
    const { t, prop, ep } = await setup("dead");
    const d = await failed(t, ep, { attempts: 3 });
    expect((await replayDelivery(t.tenantId, t.actor.id, d.id)).status).toBe("PROCESSED");
    const d2 = await failed(t, ep, { attempts: 3 }); // même réservation, nouvelle livraison : idempotent
    await replayDelivery(t.tenantId, t.actor.id, d2.id);
    expect(await db.select().from(schema.reservationNights).where(eq(schema.reservationNights.propertyId, prop))).toHaveLength(3);
  });

  it("refuse de rejouer une livraison saine, sans point de réception, ou d'un autre compte", async () => {
    const { t, ep } = await setup("refuse"), other = await setup("refuse2");
    const ok = await failed(t, ep, { status: "PROCESSED", error: null });
    await expect(replayDelivery(t.tenantId, t.actor.id, ok.id)).rejects.toThrow(/rien à rejouer/);
    const orphan = await failed(t, null);
    await expect(replayDelivery(t.tenantId, t.actor.id, orphan.id)).rejects.toThrow(/supprimé/);
    const foreign = await failed(other.t, other.ep);
    await expect(replayDelivery(t.tenantId, t.actor.id, foreign.id)).rejects.toThrow(/introuvable/);
    await expect(dismissDelivery(t.tenantId, t.actor.id, foreign.id)).rejects.toThrow(/introuvable/);
    expect((await row(foreign.id)).status).toBe("FAILED");
    expect((await listIngestionErrors(t.tenantId)).total).toBe(1); // seule l'orpheline reste
  });

  it("un rejeu qui échoue encore reste dans la file avec sa raison", async () => {
    const { t, ep } = await setup("still");
    const d = await failed(t, ep, { payload: { id: "pas-une-resa" } });
    const r = await replayDelivery(t.tenantId, t.actor.id, d.id);
    expect(r.status).toBe("FAILED");
    expect((await row(d.id)).status).toBe("FAILED");
    expect((await listIngestionErrors(t.tenantId)).total).toBe(1);
  });

  it("rejoue une livraison restée bloquée, refuse une livraison encore en cours, et un double rejeu simultané ne traite qu'une fois", async () => {
    const { t, prop, ep } = await setup("stuck");
    const recent = await failed(t, ep, { status: "PROCESSING", claimedAt: new Date() });
    await expect(replayDelivery(t.tenantId, t.actor.id, recent.id)).rejects.toThrow(/rien à rejouer/);
    await expect(dismissDelivery(t.tenantId, t.actor.id, recent.id)).rejects.toThrow(/rien à écarter/);
    const old = await failed(t, ep, { status: "PROCESSING", claimedAt: new Date(Date.now() - 5 * 60_000) });
    const res = await Promise.allSettled([replayDelivery(t.tenantId, t.actor.id, old.id), replayDelivery(t.tenantId, t.actor.id, old.id)]);
    expect(res.filter((x) => x.status === "fulfilled" && x.value.status === "PROCESSED")).toHaveLength(1); // l'autre : SKIPPED ou refus « rien à rejouer »
    expect(await db.select().from(schema.reservationNights).where(eq(schema.reservationNights.propertyId, prop))).toHaveLength(3);
    expect(await audits(t, "integration.webhook_replayed")).toHaveLength(1); // le rejeu sans effet n'est pas audité
  });

  it("un écartement n'écrase pas une livraison qu'un traitement vient de reprendre", async () => {
    const { t, ep } = await setup("race");
    const d = await failed(t, ep);
    await db.update(schema.webhookDeliveries).set({ status: "PROCESSING", claimedAt: new Date() }).where(eq(schema.webhookDeliveries.id, d.id));
    await expect(dismissDelivery(t.tenantId, t.actor.id, d.id)).rejects.toThrow();
    expect((await row(d.id)).status).toBe("PROCESSING");
    expect(await audits(t, "integration.webhook_dismissed")).toHaveLength(0);
  });

  it("écarte une livraison : elle sort de la file, avec trace, et ne peut plus être écartée deux fois", async () => {
    const { t, ep } = await setup("dismiss");
    const d = await failed(t, ep);
    await dismissDelivery(t.tenantId, t.actor.id, d.id);
    expect(await row(d.id)).toMatchObject({ status: "IGNORED", outcome: "Écartée par le propriétaire" });
    expect(await audits(t, "integration.webhook_dismissed")).toHaveLength(1);
    expect((await listIngestionErrors(t.tenantId)).total).toBe(0);
    await expect(dismissDelivery(t.tenantId, t.actor.id, d.id)).rejects.toThrow(/rien à écarter/);
  });

  it("« tout rejouer » traite le lot, ignore les orphelines et isole les comptes", async () => {
    const { t, ep } = await setup("all"), other = await setup("all2");
    await failed(t, ep, { externalId: "1", payload: resa({ id: 1, external_id: "A" }) });
    await failed(t, ep, { externalId: "2", payload: resa({ id: 2, external_id: "B", checkin: "2027-02-01", checkout: "2027-02-03", nights: 2 }) });
    await failed(t, null);
    const foreign = await failed(other.t, other.ep);
    const r = await replayAll(t.tenantId, t.actor.id);
    expect(r).toMatchObject({ replayed: 2, applied: 2, failed: 0, remaining: 0 });
    expect((await row(foreign.id)).status).toBe("FAILED");
    expect((await listIngestionErrors(other.t.tenantId)).total).toBe(1);
    expect(await replayAll(t.tenantId, t.actor.id)).toMatchObject({ replayed: 0 });
  });

  it("« tout rejouer » : les orphelines n'occupent pas le lot, et le reliquat est annoncé", async () => {
    const { t, ep } = await setup("batch");
    for (let i = 0; i < 25; i++) await failed(t, null);
    for (let i = 0; i < 22; i++) await failed(t, ep, { externalId: String(900 + i), payload: resa({ id: 900 + i, external_id: "Z" + i, checkin: "2027-04-01", checkout: "2027-04-02", nights: 1 }) });
    const r = await replayAll(t.tenantId, t.actor.id);
    expect(r).toMatchObject({ replayed: 20, applied: 20, remaining: 1 });
    expect(await replayAll(t.tenantId, t.actor.id)).toMatchObject({ replayed: 2, remaining: 0 });
  });
});
