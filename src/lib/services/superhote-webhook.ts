/**
 * Webhooks SuperHote (US-030) : enregistrement chez SuperHote et traitement des livraisons.
 *
 * Réception : signature vérifiée sur le corps brut → livraison inscrite dans la boîte de réception sous `X-Superhote-Delivery` (idempotence) →
 * traitement par l'écriture unitaire d'US-031 (`applyReservation`) → réponse 2xx. Un échec de traitement n'est jamais renvoyé à SuperHote
 * (la livraison est déjà inscrite) : elle reste FAILED, visible et rejouable (US-033), et la réconciliation (US-032) rattrape l'écart.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { withTenant, type TenantTx } from "@/db/tenant";
import { recordAudit } from "../audit/log";
import { todayISO } from "../dates";
import type { EconomicModel } from "../engine/types";
import { createWebhook, deleteWebhook, SuperhoteError } from "../integrations/superhote";
import { fingerprintToken, MAX_WEBHOOK_BYTES, parseDelivery, RESERVATION_EVENTS, verifySignature } from "../integrations/superhote-webhook";
import { previewAuthConfig } from "../preview-auth";
import { maskPii } from "../privacy/pii";
import { decryptSecret, encryptSecret } from "../secret";
import { applyCalendarEffect, applyReservation } from "./reservation-ingest";
import { SyncError } from "./pricelabs-sync";

const { properties, superhoteWebhooks, webhookDeliveries } = schema;
export const WEBHOOK_PATH = "/api/webhooks/superhote/";

/** Empreinte du jeton (voir `fingerprintToken`) ; l'absence de APP_SECRET est présentée au propriétaire. */
export function tokenFingerprint(token: string): string {
  try { return fingerprintToken(token); } catch (e) { throw new SyncError(e instanceof Error ? e.message : "Empreinte impossible."); }
}

/** Adresse publique de réception : SUPERHOTE_WEBHOOK_BASE_URL, sinon APP_URL. Doit être en https et joignable depuis Internet (SuperHote refuse les adresses privées). */
export function webhookBaseUrl(): string | null {
  const raw = (process.env.SUPERHOTE_WEBHOOK_BASE_URL || process.env.APP_URL || "").trim().replace(/\/+$/, "");
  try { const u = new URL(raw); return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null; } catch { return null; }
}
const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.test|.*\.internal|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?)/i;
export function publicWebhookUrl(endpointId: string): { url: string } | { error: string } {
  const base = webhookBaseUrl();
  if (!base) return { error: "L'adresse publique de l'application (APP_URL ou SUPERHOTE_WEBHOOK_BASE_URL) n'est pas renseignée ou n'est pas valide : SuperHote ne saurait pas où envoyer ses événements." };
  if (previewAuthConfig().state !== "off") return { error: "Cette instance est protégée par un mot de passe (Preview) : SuperHote ne pourrait pas y livrer ses événements. Les webhooks s'activent sur Staging ou en production." };
  const u = new URL(base);
  if (u.protocol !== "https:" || PRIVATE_HOST.test(u.hostname)) return { error: `L'adresse ${u.origin} n'est pas joignable par SuperHote (https public exigé). Les webhooks ne s'activent que sur un environnement exposé sur Internet (Staging, production).` };
  return { url: `${u.origin}${WEBHOOK_PATH}${endpointId}` };
}

async function getProp(tenantId: string, id: string) {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, id), eq(properties.tenantId, tenantId)));
  if (!p) throw new SyncError("Logement introuvable.");
  if (p.isDemo) throw new SyncError("Un logement de démonstration ne se connecte pas à SuperHote.");
  if (!p.superhote?.apiKeyEnc) throw new SyncError("Enregistrez d'abord le jeton API SuperHote de ce logement.");
  return p;
}
const tokenOf = (p: { superhote: Record<string, any> | null }) => decryptSecret(p.superhote!.apiKeyEnc as string);

export type WebhookStatus = { active: false; reason: string | null } | { active: true; url: string; events: string[]; since: Date; lastReceivedAt: Date | null; counts: Record<string, number>; lastFailure: string | null };

/** État des webhooks d'un logement : celui de son jeton (partagé avec les autres logements du même compte SuperHote). */
export async function webhookStatus(tenantId: string, propertyId: string): Promise<WebhookStatus> {
  const [p] = await db.select({ sh: properties.superhote }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p?.sh?.apiKeyEnc) return { active: false, reason: null };
  let fp: string; try { fp = tokenFingerprint(decryptSecret(p.sh.apiKeyEnc)); } catch { return { active: false, reason: "Jeton illisible." }; }
  const [ep] = await db.select().from(superhoteWebhooks).where(and(eq(superhoteWebhooks.tenantId, tenantId), eq(superhoteWebhooks.tokenFingerprint, fp)));
  if (!ep) { const t = publicWebhookUrl("x"); return { active: false, reason: "error" in t ? t.error : null }; }
  const rows = await db.select({ status: webhookDeliveries.status, n: sql<number>`count(*)::int`, last: sql<string | null>`max(case when ${webhookDeliveries.status} = 'FAILED' then ${webhookDeliveries.error} end)` }).from(webhookDeliveries).where(and(eq(webhookDeliveries.tenantId, tenantId), eq(webhookDeliveries.endpointId, ep.id))).groupBy(webhookDeliveries.status);
  return { active: true, url: ep.url, events: ep.events, since: ep.createdAt, lastReceivedAt: ep.lastReceivedAt, counts: Object.fromEntries(rows.map((r) => [r.status, r.n])), lastFailure: rows.find((r) => r.status === "FAILED")?.last ?? null };
}

/** Abonne SuperHote aux événements de réservation pour le compte de ce jeton (un seul webhook par jeton, même pour plusieurs logements). */
export async function enableWebhook(tenantId: string, propertyId: string, actor: string): Promise<{ created: boolean }> {
  const p = await getProp(tenantId, propertyId);
  if (!p.superhote?.rentalId) throw new SyncError("Rattachez d'abord le logement SuperHote : les événements sont aiguillés par son identifiant.");
  const token = tokenOf(p), fp = tokenFingerprint(token);
  const [existing] = await db.select({ id: superhoteWebhooks.id }).from(superhoteWebhooks).where(and(eq(superhoteWebhooks.tenantId, tenantId), eq(superhoteWebhooks.tokenFingerprint, fp)));
  if (existing) return { created: false };
  const id = newId("whk"), target = publicWebhookUrl(id);
  if ("error" in target) throw new SyncError(target.error);
  let remote: { id: string; secret: string };
  try { remote = await createWebhook(token, target.url, [...RESERVATION_EVENTS]); }
  catch (e) {
    if (e instanceof SuperhoteError && e.status === 403) throw new SyncError("Ce jeton n'a pas le droit de gérer les webhooks. Dans SuperHote (Plateformes → API), ajoutez le scope « public-api:webhooks.manage » au jeton, puis réessayez.");
    if (e instanceof SuperhoteError) throw new SyncError(e.message);
    throw e;
  }
  try {
    await db.insert(superhoteWebhooks).values({ id, tenantId, tokenFingerprint: fp, remoteId: remote.id, secretEnc: encryptSecret(remote.secret), url: target.url, events: [...RESERVATION_EVENTS], createdBy: actor });
  } catch (e) {
    // course : un autre appel vient de l'enregistrer, ou l'écriture a échoué ; le webhook distant orphelin est retiré pour ne pas occuper l'une des 10 places
    try { await deleteWebhook(token, remote.id); } catch { /* le propriétaire pourra le supprimer chez SuperHote */ }
    const [again] = await db.select({ id: superhoteWebhooks.id }).from(superhoteWebhooks).where(and(eq(superhoteWebhooks.tenantId, tenantId), eq(superhoteWebhooks.tokenFingerprint, fp)));
    if (again) return { created: false };
    throw e;
  }
  await recordAudit(db, { tenantId, actor, type: "integration.superhote_webhook_registered", entity: "Property", entityId: p.id, summary: `Webhooks SuperHote activés pour le compte du jeton ${p.superhote.keyHint ?? ""} (événements de réservation).`, payload: { url: target.url, events: RESERVATION_EVENTS } });
  return { created: true };
}

/** Supprime le webhook du jeton (chez SuperHote puis ici). Concerne tous les logements de ce compte : la réconciliation reste le filet de sécurité. */
export async function disableWebhook(tenantId: string, propertyId: string, actor: string): Promise<{ removed: boolean }> {
  const p = await getProp(tenantId, propertyId);
  const token = tokenOf(p), fp = tokenFingerprint(token);
  const [ep] = await db.select().from(superhoteWebhooks).where(and(eq(superhoteWebhooks.tenantId, tenantId), eq(superhoteWebhooks.tokenFingerprint, fp)));
  if (!ep) return { removed: false };
  try { await deleteWebhook(token, ep.remoteId); }
  catch (e) {
    if (e instanceof SuperhoteError && e.status === 403) throw new SyncError("Ce jeton n'a pas le droit de gérer les webhooks (scope « public-api:webhooks.manage »). Le webhook n'a pas été supprimé.");
    if (e instanceof SuperhoteError) throw new SyncError(e.message + " Le webhook n'a pas été supprimé.");
    throw e;
  }
  await db.delete(superhoteWebhooks).where(eq(superhoteWebhooks.id, ep.id));
  await recordAudit(db, { tenantId, actor, type: "integration.superhote_webhook_removed", entity: "Property", entityId: p.id, summary: "Webhooks SuperHote supprimés : plus aucun événement n'est reçu, la lecture planifiée reste active." });
  return { removed: true };
}

/** Appelé quand le jeton d'un logement est supprimé : retire le webhook si aucun autre logement du propriétaire n'utilise ce jeton. Jamais bloquant. */
export async function cleanupWebhookForToken(tenantId: string, token: string, exceptPropertyId: string): Promise<void> {
  try {
    const fp = tokenFingerprint(token);
    const others = await db.select({ sh: properties.superhote }).from(properties).where(and(eq(properties.tenantId, tenantId), sql`${properties.id} <> ${exceptPropertyId}`));
    if (others.some((o) => { try { return o.sh?.apiKeyEnc && tokenFingerprint(decryptSecret(o.sh.apiKeyEnc)) === fp; } catch { return false; } })) return;
    const [ep] = await db.select().from(superhoteWebhooks).where(and(eq(superhoteWebhooks.tenantId, tenantId), eq(superhoteWebhooks.tokenFingerprint, fp)));
    if (!ep) return;
    try { await deleteWebhook(token, ep.remoteId); }
    catch (e) {
      // SuperHote n'a pas confirmé la suppression : le point de réception est conservé (il continue de recevoir) et l'écart est consigné
      console.error("[superhote-webhook] suppression distante impossible :", e instanceof Error ? e.message : e);
      await recordAudit(db, { tenantId, actor: "system", type: "integration.superhote_webhook_removed", entity: "Property", entityId: exceptPropertyId, summary: "Le webhook SuperHote n'a pas pu être supprimé chez SuperHote (droits du jeton ou réseau) : à retirer dans SuperHote (Plateformes → API).", payload: { remoteId: ep.remoteId } });
      return;
    }
    await db.delete(superhoteWebhooks).where(eq(superhoteWebhooks.id, ep.id));
  } catch (e) { console.error("[superhote-webhook] nettoyage impossible :", e instanceof Error ? e.message : e); }
}

// ───────────────────────── réception ─────────────────────────

export type ReceiveResult = { status: number; body: Record<string, unknown> };
const reply = (status: number, body: Record<string, unknown>): ReceiveResult => ({ status, body });

export async function receiveWebhook(endpointId: string, raw: Buffer, headers: { signature: string | null; event: string | null; delivery: string | null }): Promise<ReceiveResult> {
  if (raw.length > MAX_WEBHOOK_BYTES) return reply(413, { error: "Corps trop volumineux." });
  const [ep] = await db.select().from(superhoteWebhooks).where(eq(superhoteWebhooks.id, endpointId));
  if (!ep) return reply(404, { error: "Point de réception inconnu." });
  let secret: string;
  try { secret = decryptSecret(ep.secretEnc); } catch { console.error("[superhote-webhook] secret de webhook illisible (APP_SECRET modifié ?)"); return reply(500, { error: "Configuration illisible." }); }
  if (!verifySignature(raw, headers.signature, secret)) return reply(401, { error: "Signature invalide." });

  const parsed = parseDelivery(raw, { event: headers.event, delivery: headers.delivery });
  if (!parsed.ok) return reply(400, { error: parsed.reason });

  const tenantId = ep.tenantId;
  const base = { id: newId("whd"), tenantId, endpointId: ep.id, deliveryId: parsed.deliveryId, event: parsed.event };
  const row = parsed.kind === "reservation" ? { ...base, externalId: parsed.reservation.id, payload: parsed.payload } : { ...base, payload: {} };
  // inscription AVANT traitement : si la base est indisponible, on répond 5xx et SuperHote réessaie (1 puis 5 minutes)
  const rowId = await withTenant(tenantId, async (tx) => {
    await tx.update(superhoteWebhooks).set({ lastReceivedAt: new Date() }).where(eq(superhoteWebhooks.id, ep.id));
    const ins = await tx.insert(webhookDeliveries).values(row).onConflictDoNothing().returning({ id: webhookDeliveries.id });
    if (ins.length) return ins[0].id;
    const [prev] = await tx.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(and(eq(webhookDeliveries.endpointId, ep.id), eq(webhookDeliveries.deliveryId, parsed.deliveryId)));
    return prev.id;
  });
  if (parsed.kind === "other") {
    const claimed = await claim(tenantId, rowId, false);
    if (!claimed) return reply(200, { received: true, duplicate: true });
    await finish(tenantId, rowId, "IGNORED", "Événement hors réservation", null);
    return reply(200, { received: true, status: "IGNORED" });
  }
  const r = await processDelivery(tenantId, rowId);
  if (r.status === "SKIPPED") return reply(200, { received: true, duplicate: true });
  // une panne transitoire est renvoyée à SuperHote (il réessaie, et la livraison est reprise) ; au-delà de MAX_ATTEMPTS ou pour une erreur définitive, 200 : la livraison reste FAILED, visible et rejouable
  if (r.status === "FAILED" && r.retryable) return reply(500, { received: true, status: "FAILED", retry: true });
  return reply(200, { received: true, status: r.status });
}

/** Nombre de traitements tentés avant d'abandonner la reprise automatique (au-delà : FAILED visible, rejeu manuel). */
export const MAX_ATTEMPTS = 3;
/** Erreur dont le message est écrit tel quel sur la livraison ; tout autre message est remplacé par une phrase générique (pas de SQL ni de paramètres). */
export class DeliveryError extends Error { constructor(message: string, public retryable = false) { super(message); } }

/**
 * Réclame une livraison : un seul traitement à la fois, jamais deux fois le même état. Réclamable si inscrite (RECEIVED), en échec avec des tentatives
 * restantes (ou `force`, pour le rejeu manuel), ou réclamée depuis plus d'une minute (traitement interrompu).
 */
async function claim(tenantId: string, id: string, force: boolean): Promise<boolean> {
  const rows = await withTenant(tenantId, (tx) => tx.update(webhookDeliveries).set({ status: "PROCESSING", claimedAt: new Date() }).where(and(eq(webhookDeliveries.id, id), sql`(${webhookDeliveries.status} = 'RECEIVED' or (${webhookDeliveries.status} = 'FAILED' and (${force} or ${webhookDeliveries.attempts} < ${MAX_ATTEMPTS})) or (${webhookDeliveries.status} = 'PROCESSING' and ${webhookDeliveries.claimedAt} < now() - interval '1 minute'))`)).returning({ id: webhookDeliveries.id }));
  return rows.length > 0;
}

async function finish(tenantId: string, id: string, status: "PROCESSED" | "IGNORED" | "FAILED", outcome: string | null, error: string | null, propertyId?: string | null) {
  await withTenant(tenantId, (tx) => tx.update(webhookDeliveries).set({ status, outcome, error, claimedAt: null, processedAt: new Date(), attempts: sql`${webhookDeliveries.attempts} + 1`, ...(propertyId ? { propertyId } : {}) }).where(eq(webhookDeliveries.id, id)));
}

export type ProcessResult = { status: "PROCESSED" | "IGNORED" | "SKIPPED"; outcome: string | null } | { status: "FAILED"; outcome: null; retryable: boolean };

/** Traite une livraison inscrite (appelé à la réception ; sert aussi au rejeu, US-033 avec `force`). Ne lève jamais : l'échec est consigné sur la livraison. SKIPPED : déjà traitée ou en cours ailleurs. */
export async function processDelivery(tenantId: string, deliveryRowId: string, opts: { force?: boolean } = {}): Promise<ProcessResult> {
  if (!(await claim(tenantId, deliveryRowId, !!opts.force))) return { status: "SKIPPED", outcome: null };
  try {
    const out = await withTenant(tenantId, (tx) => processInTx(tx, tenantId, deliveryRowId));
    await finish(tenantId, deliveryRowId, out.status, out.outcome, null, out.propertyId);
    return { status: out.status, outcome: out.outcome };
  } catch (e) {
    const domain = e instanceof DeliveryError;
    console.error("[superhote-webhook] traitement en échec :", maskPii(e instanceof Error ? e.message : String(e)).slice(0, 300));
    await finish(tenantId, deliveryRowId, "FAILED", null, domain ? maskPii(e.message).slice(0, 300) : "Écriture impossible (erreur technique). La lecture planifiée rattrapera l'écart.");
    const [d] = await withTenant(tenantId, (tx) => tx.select({ attempts: webhookDeliveries.attempts }).from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryRowId)));
    return { status: "FAILED", outcome: null, retryable: !(domain && !e.retryable) && (d?.attempts ?? MAX_ATTEMPTS) < MAX_ATTEMPTS };
  }
}

async function processInTx(tx: TenantTx, tenantId: string, id: string): Promise<{ status: "PROCESSED" | "IGNORED"; outcome: string; propertyId: string | null }> {
  const [d] = await tx.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
  if (!d) throw new DeliveryError("Livraison introuvable.");
  if (!d.endpointId) throw new DeliveryError("Point de réception supprimé : livraison non rejouable.");
  const [ep] = await tx.select().from(superhoteWebhooks).where(eq(superhoteWebhooks.id, d.endpointId));
  if (!ep) throw new DeliveryError("Point de réception supprimé : livraison non rejouable.");
  const parsed = parseDelivery(Buffer.from(JSON.stringify({ data: { reservation: d.payload } })), { event: d.event, delivery: d.deliveryId });
  if (!parsed.ok || parsed.kind !== "reservation") throw new DeliveryError("Charge utile illisible.");
  const reservation = parsed.reservation;
  // logement rattaché à ce rental_id ET à ce compte (même jeton) ; aucun rattachement = événement ignoré, pas une erreur
  const cands = await tx.select().from(properties).where(and(eq(properties.tenantId, tenantId), eq(properties.isDemo, false), sql`${properties.superhote}->>'rentalId' = ${reservation.rentalId}`));
  const prop = cands.find((c) => { try { return c.superhote?.apiKeyEnc && tokenFingerprint(decryptSecret(c.superhote.apiKeyEnc)) === ep.tokenFingerprint; } catch { return false; } });
  if (!prop) return { status: "IGNORED", outcome: "Logement non rattaché à NuitSignal", propertyId: null };
  const r = await applyReservation(tx, { tenantId, propertyId: prop.id, model: prop.economics as EconomicModel | null, reservation, source: "WEBHOOK", deliveryId: d.deliveryId });
  if (r.window) await applyCalendarEffect(tx, prop.id, r.window, [], todayISO());
  return { status: "PROCESSED", outcome: r.outcome, propertyId: prop.id };
}
