import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { todayISO } from "@/lib/dates";
import { can, denyMessage, ROLE_LABEL, PERMISSION_LABEL, type Permission, type Role } from "@/lib/rbac";
import { findDuplicate, promotionView, unknownStacking, validatePromotion, type CleanPromotion, type RegistryRow } from "@/lib/promotions/registry";

/**
 * Registre des promotions (US-100). Les écrans (actions serveur) passent tous par ici : mêmes règles, même isolation par propriétaire
 * d'espace, même journal d'audit, chaque écriture et son événement dans la même transaction.
 * Aucune écriture chez Airbnb ou Booking.com : le registre reflète ce que l'opérateur a relevé dans l'extranet officiel.
 */
const { promotions, properties, listings } = schema;
export type PromotionActor = { id: string; name: string; tenantId: string; role: Role };
export type PromotionErrorCode = "NOT_FOUND" | "INVALID" | "CONFLICT" | "FORBIDDEN";
export class PromotionError extends Error {
  constructor(public code: PromotionErrorCode, message: string) { super(message); this.name = "PromotionError"; }
}
export type Promotion = typeof promotions.$inferSelect;
/** Verrou le temps de la transaction : deux déclarations ou modifications simultanées sur un logement passent l'une après l'autre (contrôle de doublon fiable). */
const lockProperty = (tx: Pick<typeof db, "execute">, propertyId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"promo:" + propertyId}))`);
const fr = (d: string) => d.split("-").reverse().join("/");

/** Droit requis ; un refus est inscrit au journal (famille « Accès ») puis levé, comme pour le circuit de décision. */
async function need(actor: PromotionActor, permission: Permission, propertyId: string) {
  if (can(actor.role, permission)) return;
  try {
    await recordAudit(db, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "access.denied", entity: "Property", entityId: propertyId.slice(0, 64), summary: `${actor.name} (${ROLE_LABEL[actor.role]}) : tentative refusée — ${PERMISSION_LABEL[permission]}.`, payload: { permission, role: actor.role } });
  } catch (e) { console.error("[rbac] refus non consigné", (e as Error).message); }
  throw new PromotionError("FORBIDDEN", denyMessage(actor.role, permission));
}

async function propertyOf(tenantId: string, propertyId: string) {
  const [p] = await db.select({ id: properties.id, name: properties.name, status: properties.status }).from(properties).where(and(eq(properties.id, propertyId), eq(properties.tenantId, tenantId)));
  if (!p) throw new PromotionError("NOT_FOUND", "Logement introuvable.");
  return p;
}
async function promotionOf(tenantId: string, id: string, ex: Pick<typeof db, "select"> = db): Promise<Promotion> {
  const [r] = await ex.select().from(promotions).where(and(eq(promotions.id, id), eq(promotions.tenantId, tenantId)));
  if (!r) throw new PromotionError("NOT_FOUND", "Promotion introuvable.");
  return r;
}
const asRow = (r: Promotion): RegistryRow => ({ id: r.id, channel: r.channel, kind: r.kind, label: r.label, discountPct: r.discountPct, status: r.status, stayFrom: r.stayFrom, stayTo: r.stayTo, listingId: r.listingId, verifiedAt: r.verifiedAt });

/** L'annonce visée doit exister, appartenir au logement et au même canal ; elle peut être archivée (l'historique reste lisible) mais pas supprimée. */
async function checkListing(tenantId: string, propertyId: string, c: CleanPromotion) {
  if (!c.listingId) return;
  const [l] = await db.select({ channel: listings.channel }).from(listings).where(and(eq(listings.id, c.listingId), eq(listings.tenantId, tenantId), eq(listings.propertyId, propertyId)));
  if (!l) throw new PromotionError("INVALID", "L'annonce choisie n'existe pas pour ce logement.");
  if (l.channel !== c.channel) throw new PromotionError("INVALID", "L'annonce choisie n'est pas sur le même canal que la promotion.");
}

/** Promotions d'un logement : les actives d'abord, puis les planifiées, puis les terminées (les plus récentes en premier). */
export async function listPromotions(tenantId: string, propertyId: string, now: Date = new Date()) {
  const rows = await db.select().from(promotions).where(and(eq(promotions.tenantId, tenantId), eq(promotions.propertyId, propertyId))).orderBy(asc(promotions.stayFrom), desc(promotions.createdAt));
  const today = todayISO(now);
  const stack = unknownStacking(rows.map(asRow), today);
  const rank: Record<string, number> = { ACTIVE: 0, PLANNED: 1, EXPIRED: 2, ENDED: 3 };
  return rows.map((r) => ({ ...r, view: promotionView(r, today, now), unknownStackWith: stack.get(r.id) ?? [] }))
    .sort((a, b) => rank[a.view.state] - rank[b.view.state]);
}
export type PromotionListItem = Awaited<ReturnType<typeof listPromotions>>[number];

/**
 * Déclare au registre une promotion existante dans l'extranet du canal. Elle est « active » et vérifiée à l'instant : la personne vient de la lire.
 * Refusé : saisie invalide, doublon (même canal, type, annonce et séjours qui se recoupent), annonce d'un autre logement ou d'un autre canal.
 */
export async function declarePromotion(actor: PromotionActor, propertyId: string, raw: Record<string, unknown>, now: Date = new Date()): Promise<Promotion> {
  const p = await propertyOf(actor.tenantId, propertyId);
  await need(actor, "promotion.manage", propertyId);
  const v = validatePromotion(raw, todayISO(now));
  if (!v.ok) throw new PromotionError("INVALID", v.error);
  const c = v.value;
  await checkListing(actor.tenantId, propertyId, c);
  return db.transaction(async (tx) => {
    await lockProperty(tx, propertyId);
    const existing = await tx.select().from(promotions).where(and(eq(promotions.tenantId, actor.tenantId), eq(promotions.propertyId, propertyId), ne(promotions.status, "ENDED")));
    const dup = findDuplicate(existing.map(asRow), c);
    if (dup) throw new PromotionError("CONFLICT", `« ${dup.label} » (même canal, même type) couvre déjà ces séjours : modifiez-la ou terminez-la d'abord.`);
    const [row] = await tx.insert(promotions).values({ id: newId("promo"), tenantId: actor.tenantId, propertyId, ...c, status: "ACTIVE", source: "MANUAL", verifiedAt: now, verifiedBy: actor.id, createdBy: actor.id }).returning();
    await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "promotion.declared", entity: "Property", entityId: propertyId,
      summary: `${actor.name} déclare au registre « ${c.label} » (${c.channel === "BOOKING" ? "Booking.com" : "Airbnb"}, −${c.discountPct} %) sur ${p.name}.`,
      payload: { promotionId: row.id, channel: c.channel, kind: c.kind, discountPct: c.discountPct, stayFrom: c.stayFrom, stayTo: c.stayTo, externalRef: c.externalRef } });
    return row;
  });
}

const FIELDS: [keyof CleanPromotion, string][] = [["label", "libellé"], ["discountPct", "remise"], ["stayFrom", "début des séjours"], ["stayTo", "fin des séjours"], ["bookFrom", "début des réservations"], ["bookTo", "fin des réservations"], ["minLos", "durée minimale"], ["listingId", "annonce"], ["externalRef", "identifiant"]];
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));

/** Modifie une promotion non terminée. Le canal et le type ne changent pas (c'est une autre promotion : terminez celle-ci et déclarez-en une nouvelle). */
export async function updatePromotion(actor: PromotionActor, id: string, raw: Record<string, unknown>, now: Date = new Date()): Promise<Promotion> {
  const cur = await promotionOf(actor.tenantId, id);
  await need(actor, "promotion.manage", cur.propertyId);
  if (cur.status === "ENDED") throw new PromotionError("CONFLICT", "Cette promotion est terminée : elle ne peut plus être modifiée.");
  const v = validatePromotion({ ...raw, channel: cur.channel, kind: cur.kind }, todayISO(now));
  if (!v.ok) throw new PromotionError("INVALID", v.error);
  const c = v.value;
  await checkListing(actor.tenantId, cur.propertyId, c);
  const changes = FIELDS.filter(([k]) => (cur as Record<string, unknown>)[k] !== c[k]).map(([k, label]) => ({ field: k, label, from: (cur as Record<string, unknown>)[k] ?? null, to: c[k] }));
  if (!changes.length) return cur;
  return db.transaction(async (tx) => {
    await lockProperty(tx, cur.propertyId);
    const others = await tx.select().from(promotions).where(and(eq(promotions.tenantId, actor.tenantId), eq(promotions.propertyId, cur.propertyId), ne(promotions.status, "ENDED")));
    const dup = findDuplicate(others.map(asRow), c, cur.id);
    if (dup) throw new PromotionError("CONFLICT", `« ${dup.label} » (même canal, même type) couvre déjà ces séjours : modifiez-la ou terminez-la d'abord.`);
    // une modification change ce que dit le registre : la vérification précédente ne vaut plus pour la nouvelle valeur
    const [row] = await tx.update(promotions).set({ ...c, verifiedAt: null, verifiedBy: null, updatedAt: now }).where(and(eq(promotions.id, cur.id), eq(promotions.tenantId, actor.tenantId), ne(promotions.status, "ENDED"))).returning();
    if (!row) throw new PromotionError("CONFLICT", "Cette promotion vient de changer d'état : rechargez la page.");
    await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "promotion.updated", entity: "Property", entityId: cur.propertyId,
      summary: `${actor.name} modifie « ${cur.label} » : ${changes.map((x) => `${x.label} ${show(x.from)} → ${show(x.to)}`).join(", ")}. À vérifier de nouveau dans l'extranet.`,
      payload: { promotionId: cur.id, changes } });
    return row;
  });
}

/** Termine une promotion (arrêtée dans l'extranet ou arrivée à son terme). Le motif est facultatif mais conservé. */
export async function endPromotion(actor: PromotionActor, id: string, reasonRaw: unknown, now: Date = new Date()): Promise<Promotion> {
  const cur = await promotionOf(actor.tenantId, id);
  await need(actor, "promotion.manage", cur.propertyId);
  if (cur.status === "ENDED") throw new PromotionError("CONFLICT", "Cette promotion est déjà terminée.");
  const reason = String(reasonRaw ?? "").trim().slice(0, 200) || null;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(promotions).set({ status: "ENDED", endedAt: now, endReason: reason, updatedAt: now }).where(and(eq(promotions.id, cur.id), eq(promotions.tenantId, actor.tenantId), ne(promotions.status, "ENDED"))).returning();
    if (!row) throw new PromotionError("CONFLICT", "Cette promotion vient de changer d'état : rechargez la page.");
    await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "promotion.ended", entity: "Property", entityId: cur.propertyId,
      summary: `${actor.name} termine « ${cur.label} »${cur.stayTo ? ` (séjours jusqu'au ${fr(cur.stayTo)})` : ""}${reason ? ` — ${reason}` : ""}.`,
      payload: { promotionId: cur.id, reason } });
    return row;
  });
}

/**
 * Relecture dans l'extranet : la promotion existe toujours telle qu'elle est inscrite. Elle repart pour sept jours de « vérifiée ».
 * (US-104 ajoute la règle « une autre personne ou une relecture ultérieure » pour les promotions déclarées par procédure manuelle.)
 */
export async function verifyPromotion(actor: PromotionActor, id: string, now: Date = new Date()): Promise<Promotion> {
  const cur = await promotionOf(actor.tenantId, id);
  await need(actor, "action.verify", cur.propertyId);
  if (cur.status !== "ACTIVE") throw new PromotionError("CONFLICT", cur.status === "ENDED" ? "Cette promotion est terminée : il n'y a plus rien à vérifier." : "Cette promotion n'est pas encore appliquée : elle ne peut pas être vérifiée.");
  if (cur.stayTo && cur.stayTo <= todayISO(now)) throw new PromotionError("CONFLICT", "Les séjours de cette promotion sont passés : terminez-la plutôt que de la vérifier.");
  return db.transaction(async (tx) => {
    const [row] = await tx.update(promotions).set({ verifiedAt: now, verifiedBy: actor.id, updatedAt: now }).where(and(eq(promotions.id, cur.id), eq(promotions.tenantId, actor.tenantId), eq(promotions.status, "ACTIVE"))).returning();
    if (!row) throw new PromotionError("CONFLICT", "Cette promotion vient de changer d'état : rechargez la page.");
    await recordAudit(tx, { tenantId: actor.tenantId, actor: userActor(actor.id), type: "promotion.verified", entity: "Property", entityId: cur.propertyId,
      summary: `${actor.name} relit « ${cur.label} » dans l'extranet : conforme au registre.`, payload: { promotionId: cur.id } });
    return row;
  });
}
