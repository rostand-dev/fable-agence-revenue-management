/**
 * File des échecs d'ingestion SuperHote (US-033) : les livraisons de webhook qui n'ont pas pu être appliquées (FAILED), celles restées en cours
 * ou inscrites sans traitement, et les lectures planifiées en échec. Chaque échec est visible, expliqué, et rejouable ou écartable par le propriétaire.
 * Une livraison FAILED qui a épuisé ses tentatives automatiques (MAX_ATTEMPTS) est « abandonnée » : c'est la file des lettres mortes.
 */
import { and, asc, desc, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { withTenant } from "@/db/tenant";
import { recordAudit } from "../audit/log";
import { maskPii } from "../privacy/pii";
import { SyncError } from "./pricelabs-sync";
import { MAX_ATTEMPTS, processDelivery } from "./superhote-webhook";

const { webhookDeliveries, properties } = schema;
/** Une livraison inscrite ou en cours depuis plus longtemps est considérée comme interrompue. */
const STUCK_MS = 60_000;
const LIST_LIMIT = 100, REPLAY_ALL_LIMIT = 20;

export type DeliveryRow = {
  id: string; deliveryId: string; event: string; status: string; outcome: string | null; attempts: number; error: string | null;
  propertyId: string | null; propertyName: string | null; externalId: string | null; receivedAt: Date; processedAt: Date | null;
  /** Point de réception supprimé : la livraison ne peut plus être rejouée, seulement écartée. */
  replayable: boolean;
  /** « failed » : en échec, avec des tentatives automatiques restantes · « abandoned » : tentatives épuisées · « interrupted » : traitement interrompu */
  stage: "failed" | "abandoned" | "interrupted";
};
export type ReadFailure = { propertyId: string; propertyName: string; at: string; error: string; kind: "READ" | "SUSPICIOUS" };
export type IngestionErrors = { deliveries: DeliveryRow[]; total: number; abandoned: number; readFailures: ReadFailure[] };

const failingFilter = (tenantId: string, now: Date) => and(eq(webhookDeliveries.tenantId, tenantId), or(
  eq(webhookDeliveries.status, "FAILED"),
  and(inArray(webhookDeliveries.status, ["PROCESSING", "RECEIVED"]), lt(sql`coalesce(${webhookDeliveries.claimedAt}, ${webhookDeliveries.receivedAt})`, new Date(+now - STUCK_MS))),
));

export async function listIngestionErrors(tenantId: string, now = new Date()): Promise<IngestionErrors> {
  const where = failingFilter(tenantId, now);
  const rows = await db.select({ d: webhookDeliveries, name: properties.name }).from(webhookDeliveries).leftJoin(properties, and(eq(properties.id, webhookDeliveries.propertyId), eq(properties.tenantId, webhookDeliveries.tenantId))).where(where).orderBy(desc(webhookDeliveries.receivedAt)).limit(LIST_LIMIT);
  const [{ n, dead }] = await db.select({ n: sql<number>`count(*)::int`, dead: sql<number>`count(*) filter (where ${webhookDeliveries.status} = 'FAILED' and ${webhookDeliveries.attempts} >= ${MAX_ATTEMPTS})::int` }).from(webhookDeliveries).where(where);
  const deliveries = rows.map(({ d, name }): DeliveryRow => ({
    id: d.id, deliveryId: d.deliveryId, event: d.event, status: d.status, outcome: d.outcome, attempts: d.attempts, error: d.error, propertyId: d.propertyId, propertyName: name, externalId: d.externalId, receivedAt: d.receivedAt, processedAt: d.processedAt,
    replayable: !!d.endpointId, stage: d.status !== "FAILED" ? "interrupted" : d.attempts >= MAX_ATTEMPTS ? "abandoned" : "failed",
  }));
  // lectures planifiées : la dernière lecture SuperHote d'un logement est en échec, ou la dernière réconciliation a jugé la lecture suspecte
  const props = await db.select({ id: properties.id, name: properties.name, sh: properties.superhote }).from(properties).where(and(eq(properties.tenantId, tenantId), eq(properties.isDemo, false)));
  const readFailures: ReadFailure[] = [];
  for (const p of props) {
    const ls = p.sh?.lastSync;
    if (ls && ls.ok === false) readFailures.push({ propertyId: p.id, propertyName: p.name, at: String(ls.at ?? ""), error: maskPii(String(ls.error ?? "Lecture en échec.")).slice(0, 300), kind: "READ" });
    else if (p.sh?.lastReconcile?.suspicious) readFailures.push({ propertyId: p.id, propertyName: p.name, at: String(p.sh.lastReconcile.at ?? ""), error: "SuperHote n'a renvoyé aucune réservation alors que le logement en a : la lecture est ignorée, rien n'a été annulé.", kind: "SUSPICIOUS" });
  }
  return { deliveries, total: n, abandoned: dead, readFailures };
}

/** Nombre d'échecs à traiter (pastille de l'écran). */
export async function ingestionErrorCount(tenantId: string): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(webhookDeliveries).where(failingFilter(tenantId, new Date()));
  const props = await db.select({ sh: properties.superhote }).from(properties).where(and(eq(properties.tenantId, tenantId), eq(properties.isDemo, false)));
  return n + props.filter((p) => p.sh?.lastSync?.ok === false || p.sh?.lastReconcile?.suspicious).length;
}

/** Le traitement est déjà fait quand l'audit s'écrit : son échec est consigné mais ne doit pas faire croire que rien n'a changé. */
async function auditSafely(fn: () => Promise<unknown>) { try { await fn(); } catch (e) { console.error("[ingestion] audit non écrit :", maskPii(e instanceof Error ? e.message : String(e)).slice(0, 300)); } }

async function own(tenantId: string, id: string) {
  const [d] = await db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.id, id), eq(webhookDeliveries.tenantId, tenantId)));
  if (!d) throw new SyncError("Livraison introuvable.");
  return d;
}
const replayable = (d: { status: string; claimedAt: Date | null; receivedAt: Date }, now = new Date()) =>
  d.status === "FAILED" || (["PROCESSING", "RECEIVED"].includes(d.status) && +(d.claimedAt ?? d.receivedAt) < +now - STUCK_MS);

const OUTCOME_LABEL: Record<string, string> = { CREATED: "réservation créée", MODIFIED: "réservation modifiée", CANCELLED: "réservation annulée", REACTIVATED: "réservation réactivée", UNCHANGED: "déjà à jour", STALE: "état plus ancien que celui connu, ignoré" };
const OUTCOME_TEXT = (status: string, outcome: string | null) => status === "PROCESSED" ? `appliquée (${OUTCOME_LABEL[outcome ?? ""] ?? "ok"})` : status === "IGNORED" ? `ignorée (${outcome ?? "hors périmètre"})` : "toujours en échec";

/** Rejoue une livraison : même traitement qu'à la réception, sans limite de tentatives ; l'idempotence d'`applyReservation` rend le rejeu sans risque. */
export async function replayDelivery(tenantId: string, actor: string, id: string): Promise<{ status: string; message: string }> {
  const d = await own(tenantId, id);
  if (!replayable(d)) throw new SyncError("Cette livraison n'est pas en échec : il n'y a rien à rejouer.");
  if (!d.endpointId) throw new SyncError("Le webhook de cette livraison a été supprimé : elle ne peut plus être rejouée. Écartez-la ; la lecture planifiée rattrape les réservations.");
  const r = await processDelivery(tenantId, id, { force: true });
  if (r.status === "SKIPPED") return { status: r.status, message: "Livraison déjà prise en charge par un autre traitement : rien à rejouer." };
  const text = OUTCOME_TEXT(r.status, r.outcome);
  await auditSafely(() => recordAudit(db, { tenantId, actor, type: "integration.webhook_replayed", entity: "WebhookDelivery", entityId: id, summary: `Livraison SuperHote ${d.event} (réservation ${d.externalId ?? "?"}) rejouée : ${text}.`, payload: { deliveryId: d.deliveryId, result: r.status } }));
  return { status: r.status, message: `Livraison rejouée : ${text}.` };
}

/** Rejoue les livraisons en échec rejouables (20 au plus par passage, les moins tentées d'abord pour ne pas retraiter toujours les mêmes). */
export async function replayAll(tenantId: string, actor: string): Promise<{ replayed: number; applied: number; failed: number; remaining: number }> {
  const rows = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(and(failingFilter(tenantId, new Date()), isNotNull(webhookDeliveries.endpointId))).orderBy(asc(webhookDeliveries.attempts), asc(webhookDeliveries.receivedAt)).limit(REPLAY_ALL_LIMIT + 1);
  const batch = rows.slice(0, REPLAY_ALL_LIMIT);
  let applied = 0, failed = 0, done = 0;
  try {
    for (const r of batch) {
      const out = await processDelivery(tenantId, r.id, { force: true });
      done++;
      if (out.status === "PROCESSED" || out.status === "IGNORED") applied++; else if (out.status === "FAILED") failed++;
    }
  } finally {
    if (done) await auditSafely(() => recordAudit(db, { tenantId, actor, type: "integration.webhook_replayed", entity: "WebhookDelivery", entityId: batch[0].id, summary: `${done} livraison${done > 1 ? "s" : ""} SuperHote rejouée${done > 1 ? "s" : ""} : ${applied} appliquée${applied > 1 ? "s" : ""}, ${failed} toujours en échec.`, payload: { replayed: done, applied, failed } }));
  }
  return { replayed: done, applied, failed, remaining: Math.max(0, rows.length - REPLAY_ALL_LIMIT) };
}

/** Écarte une livraison que le propriétaire ne veut plus rejouer : elle sort de la file, avec trace. */
export async function dismissDelivery(tenantId: string, actor: string, id: string): Promise<void> {
  const d = await own(tenantId, id);
  if (!replayable(d)) throw new SyncError("Cette livraison n'est pas en échec : il n'y a rien à écarter.");
  // même condition que la réclamation : une livraison qu'un traitement vient de reprendre n'est pas écartée
  const stuck = sql`(${webhookDeliveries.status} = 'FAILED' or (${webhookDeliveries.status} in ('PROCESSING', 'RECEIVED') and coalesce(${webhookDeliveries.claimedAt}, ${webhookDeliveries.receivedAt}) < now() - interval '1 minute'))`;
  const done = await withTenant(tenantId, async (tx) => {
    const r = await tx.update(webhookDeliveries).set({ status: "IGNORED", outcome: "Écartée par le propriétaire", claimedAt: null, processedAt: new Date() }).where(and(eq(webhookDeliveries.id, id), stuck)).returning({ id: webhookDeliveries.id });
    if (r.length) await recordAudit(tx, { tenantId, actor, type: "integration.webhook_dismissed", entity: "WebhookDelivery", entityId: id, summary: `Livraison SuperHote ${d.event} (réservation ${d.externalId ?? "?"}) écartée après ${d.attempts} tentative${d.attempts > 1 ? "s" : ""} en échec.`, payload: { deliveryId: d.deliveryId, error: d.error } });
    return r;
  });
  if (!done.length) throw new SyncError("Cette livraison vient d'être traitée.");
}
