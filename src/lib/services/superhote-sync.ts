import { and, eq, ne } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "../audit/log";
import type { AuditType } from "../audit/types";
import { listRentals } from "../integrations/superhote";
import type { EconomicModel } from "../engine/types";
import { observedCommission, observedPaymentFee } from "../integrations/superhote-map";
import { addDays, todayISO } from "../dates";
import { applyCalendarEffect, reconcileReservations, type ReconcileResult } from "./reservation-ingest";
import { withTenant } from "@/db/tenant";
import { decryptSecret, encryptSecret, secretHint } from "../secret";
import { cleanupWebhookForToken } from "./superhote-webhook";
import { shErrorText, snapshotSuperhote } from "./superhote-read";
import { SyncError, syncPriceLabs } from "./pricelabs-sync";

const { properties, calendarDays } = schema;

async function getProp(tenantId: string, id: string) {
  const [p] = await db.select().from(properties).where(and(eq(properties.id, id), eq(properties.tenantId, tenantId)));
  if (!p) throw new SyncError("Logement introuvable.");
  if (p.isDemo) throw new SyncError("Un logement de démonstration ne se connecte pas à SuperHote.");
  return p;
}
const audit = (tenantId: string, actor: string, type: AuditType, id: string, summary: string, payload?: unknown) => recordAudit(db, { tenantId, actor, type, entity: "Property", entityId: id, summary, payload });

/** Logements SuperHote déjà rattachés à un autre logement du même propriétaire : identifiant → nom du logement. */
export async function rentalLinkedElsewhere(tenantId: string, propertyId: string): Promise<Map<string, string>> {
  const others = await db.select({ name: properties.name, sh: properties.superhote }).from(properties).where(and(eq(properties.tenantId, tenantId), ne(properties.id, propertyId)));
  return new Map(others.filter((o) => o.sh?.rentalId).map((o) => [String(o.sh!.rentalId), o.name]));
}

/** Enregistre le jeton (chiffré) après l'avoir vérifié auprès de SuperHote. Aucun rattachement automatique : le propriétaire confirme. */
export async function connectSuperhote(tenantId: string, propertyId: string, tokenRaw: string, actor: string): Promise<{ rentals: number }> {
  const p = await getProp(tenantId, propertyId);
  const token = tokenRaw.trim();
  if (token.length < 20 || /\s/.test(token)) throw new SyncError("Ce jeton ne ressemble pas à un jeton API SuperHote. Copiez-le en entier : il n'est affiché qu'une seule fois à sa création.");
  let rentals;
  try { rentals = await listRentals(token); } catch (e) { throw new SyncError(shErrorText(e)); }
  if (rentals.length === 0) throw new SyncError("Le jeton est valide, mais ce compte SuperHote ne contient aucun logement visible avec ses droits.");
  const previous = p.superhote?.apiKeyEnc ? (() => { try { return decryptSecret(p.superhote!.apiKeyEnc as string); } catch { return null; } })() : null;
  await db.update(properties).set({ superhote: { apiKeyEnc: encryptSecret(token), keyHint: secretHint(token), connectedAt: new Date().toISOString(), candidates: rentals.map((r) => ({ id: r.id, name: r.name, city: r.city, capacity: r.capacity })), rentalId: null, rentalName: null } }).where(eq(properties.id, p.id));
  await audit(tenantId, actor, "integration.superhote_connected", p.id, `Jeton API SuperHote enregistré pour ${p.name} (${secretHint(token)}), ${rentals.length} logement${rentals.length > 1 ? "s" : ""} visible${rentals.length > 1 ? "s" : ""}. Rattachement à confirmer.`);
  if (previous && previous !== token) await cleanupWebhookForToken(tenantId, previous, p.id); // nouveau jeton : l'ancien webhook n'a plus d'usage (il occuperait l'une des 10 places du compte)
  return { rentals: rentals.length };
}

/** Rattachement confirmé par le propriétaire ; un logement SuperHote ne peut alimenter qu'un seul de ses logements. */
export async function selectRental(tenantId: string, propertyId: string, rentalId: string, actor: string): Promise<void> {
  const p = await getProp(tenantId, propertyId);
  const c = (p.superhote?.candidates ?? []).find((x: any) => String(x.id) === rentalId);
  if (!p.superhote?.apiKeyEnc || !c) throw new SyncError("Logement inconnu pour ce jeton.");
  const taken = (await rentalLinkedElsewhere(tenantId, p.id)).get(String(c.id));
  if (taken) throw new SyncError(`Ce logement SuperHote est déjà rattaché à votre logement « ${taken} ». Un logement SuperHote ne peut alimenter qu'un seul logement.`);
  await db.update(properties).set({ superhote: { ...p.superhote, rentalId: String(c.id), rentalName: c.name } }).where(eq(properties.id, p.id));
  await audit(tenantId, actor, "integration.superhote_rental_linked", p.id, `Logement SuperHote « ${c.name} » (${c.id}) rattaché à ${p.name}.`);
  await syncSuperhote(tenantId, p.id);
}

export async function detachRental(tenantId: string, propertyId: string, actor: string): Promise<void> {
  const p = await getProp(tenantId, propertyId);
  if (!p.superhote?.apiKeyEnc) throw new SyncError("Aucun jeton SuperHote sur ce logement.");
  const { lastSync, ...rest } = p.superhote;
  await db.update(properties).set({ superhote: { ...rest, rentalId: null, rentalName: null } }).where(eq(properties.id, p.id));
  await audit(tenantId, actor, "integration.superhote_rental_unlinked", p.id, `Logement SuperHote détaché de ${p.name}.`);
}

export async function disconnectSuperhote(tenantId: string, propertyId: string, actor: string): Promise<void> {
  const p = await getProp(tenantId, propertyId);
  const token = p.superhote?.apiKeyEnc ? (() => { try { return decryptSecret(p.superhote!.apiKeyEnc as string); } catch { return null; } })() : null;
  await db.update(properties).set({ superhote: null }).where(eq(properties.id, p.id));
  if (token) await cleanupWebhookForToken(tenantId, token, p.id); // retire le webhook si plus aucun logement n'utilise ce jeton
  await audit(tenantId, actor, "integration.superhote_disconnected", p.id, `Jeton API SuperHote supprimé pour ${p.name}.`);
}

/**
 * Relit SuperHote. Si PriceLabs est rattaché, passe par sa lecture (qui compare les prix et contrôle les réservations) ;
 * sinon enregistre les réservations SuperHote et l'état de la lecture.
 */
export async function syncSuperhote(tenantId: string, propertyId: string): Promise<{ reservations: number; nights: number }> {
  const p = await getProp(tenantId, propertyId);
  if (!p.superhote?.rentalId) throw new SyncError("Aucun logement SuperHote n'est rattaché à ce logement.");
  if (p.pricelabs?.listingId) { await syncPriceLabs(tenantId, p.id); }
  else {
    const snap = await snapshotSuperhote(p.superhote);
    // SuperHote fait foi pour les réservations, même sans PriceLabs
    let rec: ReconcileResult | null = null;
    if (snap?.ok) {
      try { rec = await withTenant(tenantId, (tx) => reconcileReservations(tx, { tenantId, propertyId: p.id, model: p.economics as EconomicModel, reservations: snap.reservations, readAt: new Date(snap.at) })); }
      catch (e) { console.error("[superhote] réconciliation impossible :", e instanceof Error ? e.message : e); throw new SyncError("Les réservations lues n'ont pas pu être enregistrées (erreur technique). Rien n'a été modifié."); }
    }
    const lastSync = snap?.ok ? { ok: true, at: snap.at, reservations: snap.reservations.filter((r) => !r.canceled).length, nights: snap.calendar.length, reservationsSource: "SUPERHOTE", observedCommission: observedCommission(snap.reservations), observedPaymentFee: observedPaymentFee(snap.reservations) } : { ok: false, at: snap?.at ?? new Date().toISOString(), error: snap && !snap.ok ? snap.error : "Lecture impossible." };
    await db.update(properties).set({ superhote: { ...p.superhote, lastSync, ...(rec ? { lastReconcile: rec } : {}) } }).where(eq(properties.id, p.id));
    if (!lastSync.ok) throw new SyncError((lastSync as any).error);
  }
  const [fresh] = await db.select({ sh: properties.superhote }).from(properties).where(eq(properties.id, p.id));
  const ls = fresh?.sh?.lastSync;
  if (ls && ls.ok === false) throw new SyncError(ls.error);
  return { reservations: ls?.reservations ?? 0, nights: ls?.nights ?? 0 };
}

/**
 * Lecture légère de SuperHote, entre deux lectures PriceLabs : réservations et disponibilités seulement.
 * Les réservations sont remplacées, le calendrier déjà lu est ajusté (nuits vendues ou libérées), les prix et le marché ne bougent pas.
 * Jamais bloquante : un échec est consigné dans la dernière lecture et renvoyé, les données précédentes sont conservées.
 */
export async function refreshSuperhoteReservations(tenantId: string, propertyId: string): Promise<{ ok: true; reservations: number; patched: number } | { ok: false; error: string }> {
  const p = await getProp(tenantId, propertyId);
  if (!p.superhote?.rentalId) return { ok: false, error: "Aucun logement SuperHote n'est rattaché à ce logement." };
  const now = new Date();
  const snap = await snapshotSuperhote(p.superhote, now);
  const prev = p.superhote.lastSync ?? {};
  if (!snap?.ok) {
    const error = snap && !snap.ok ? snap.error : "Lecture impossible.";
    await db.update(properties).set({ superhote: { ...p.superhote, lastSync: { ...prev, ok: false, at: now.toISOString(), error } } }).where(eq(properties.id, p.id));
    return { ok: false, error };
  }
  const { error: _e, ...kept } = prev;
  const lastSync = { ...kept, ok: true, at: snap.at, reservations: snap.reservations.filter((r) => !r.canceled).length, nights: snap.calendar.length, reservationsSource: "SUPERHOTE", observedCommission: observedCommission(snap.reservations), observedPaymentFee: observedPaymentFee(snap.reservations) };
  let outcome: { rec: ReconcileResult; patched: number };
  try {
    outcome = await withTenant(tenantId, async (tx) => {
      const rec = await reconcileReservations(tx, { tenantId, propertyId: p.id, model: p.economics as EconomicModel, reservations: snap.reservations, readAt: new Date(snap.at) });
      // le calendrier suit les réservations RÉELLEMENT enregistrées (et non la lecture brute) : nuits vendues ou bloquées ; libérées seulement si SuperHote les déclare disponibles
      const today = todayISO(now), patched = await applyCalendarEffect(tx, p.id, { from: today, to: addDays(today, 91) }, snap.calendar, today);
      await tx.update(properties).set({ superhote: { ...p.superhote, lastSync, lastReconcile: rec } }).where(eq(properties.id, p.id));
      return { rec, patched };
    });
  } catch (e) {
    console.error("[superhote] réconciliation impossible :", e instanceof Error ? e.message : e);
    const error = "Les réservations lues n'ont pas pu être enregistrées (erreur technique). Les données précédentes sont conservées.";
    await db.update(properties).set({ superhote: { ...p.superhote, lastSync: { ...prev, ok: false, at: now.toISOString(), error } } }).where(eq(properties.id, p.id));
    return { ok: false, error };
  }
  return { ok: true, reservations: lastSync.reservations, patched: outcome.patched };
}
