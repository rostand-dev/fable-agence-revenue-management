import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { db, newId, schema } from "@/db";
import { recordAudit } from "@/lib/audit/log";
import { userActor } from "@/lib/audit/types";
import { emptyEconomics } from "@/lib/engine/economics";
import type { Strategy } from "@/lib/engine/types";
import { advance } from "@/lib/onboarding";
import { LISTING_CHANNEL_LABEL, parseListingInput, parseOwnerInput, parsePropertyIdentity, parsePropertyPatch, parseTenantName, type ListingChannel, type PropertyIdentity } from "@/lib/portfolio";

/**
 * Portefeuille (US-020) : Propriétaires, Logements, Annonces et nom de l'espace. Les écrans (actions serveur) et l'API REST passent
 * tous par ici : mêmes règles, même isolation par propriétaire d'espace, même journal d'audit. Chaque écriture et son événement
 * d'audit réussissent ou échouent ensemble (même transaction).
 */
export type PortfolioActor = { id: string; name: string; tenantId: string };
export type PortfolioErrorCode = "NOT_FOUND" | "INVALID" | "CONFLICT";
export class PortfolioError extends Error {
  constructor(public code: PortfolioErrorCode, message: string) { super(message); this.name = "PortfolioError"; }
}
const invalid = (m: string) => new PortfolioError("INVALID", m);
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Ex = Pick<typeof db, "select" | "insert">;
const { owners, listings, properties } = schema;

/** Actions de revenu qui ne doivent pas disparaître sous les pieds du propriétaire : approuvées, en cours, exécutées ou en mesure. */
const IN_FLIGHT = ["APPROVED", "EXECUTING", "EXECUTED", "VERIFIED", "MEASURING"];

// ───────────────────────── Propriétaires ─────────────────────────

/** Propriétaire par défaut de l'espace, créé au besoin (jamais deux : index unique partiel). Rejouable. */
export async function ensureDefaultOwner(ex: Ex, tenantId: string): Promise<string> {
  const find = async () => (await ex.select({ id: owners.id }).from(owners).where(and(eq(owners.tenantId, tenantId), eq(owners.isDefault, true))).limit(1))[0]?.id;
  const existing = await find();
  if (existing) return existing;
  const [t] = await ex.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
  await ex.insert(owners).values({ id: newId("own"), tenantId, name: (t?.name ?? "Propriétaire").slice(0, 80), isDefault: true }).onConflictDoNothing();
  const id = await find();
  if (!id) throw new PortfolioError("NOT_FOUND", "Espace introuvable.");
  return id;
}

export async function listOwners(tenantId: string) {
  await ensureDefaultOwner(db, tenantId);
  const rows = await db.select().from(owners).where(eq(owners.tenantId, tenantId)).orderBy(asc(owners.createdAt), asc(owners.id));
  const counts = await db.select({ ownerId: properties.ownerId, n: count() }).from(properties).where(eq(properties.tenantId, tenantId)).groupBy(properties.ownerId);
  const byOwner = new Map(counts.map((c) => [c.ownerId, Number(c.n)]));
  return rows.map((o) => ({ ...o, propertyCount: byOwner.get(o.id) ?? 0 }));
}
async function loadOwner(ex: Ex, tenantId: string, id: string) {
  const [o] = await ex.select().from(owners).where(and(eq(owners.id, id), eq(owners.tenantId, tenantId)));
  if (!o) throw new PortfolioError("NOT_FOUND", "Propriétaire introuvable.");
  return o;
}
async function assertOwnerNameFree(ex: Ex, tenantId: string, name: string, exceptId?: string) {
  const same = await ex.select({ id: owners.id }).from(owners).where(and(eq(owners.tenantId, tenantId), sql`lower(${owners.name}) = lower(${name})`, ...(exceptId ? [ne(owners.id, exceptId)] : [])));
  if (same.length) throw new PortfolioError("CONFLICT", `Un propriétaire nommé « ${name} » existe déjà.`);
}

export async function createOwner(u: PortfolioActor, raw: Record<string, unknown>) {
  const p = parseOwnerInput(raw);
  if (!p.ok) throw invalid(p.error);
  return db.transaction(async (tx) => {
    await ensureDefaultOwner(tx, u.tenantId);
    await assertOwnerNameFree(tx, u.tenantId, p.value.name);
    const id = newId("own");
    await tx.insert(owners).values({ id, tenantId: u.tenantId, ...p.value });
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "owner.created", entity: "Owner", entityId: id, summary: `${u.name} ajoute le propriétaire ${p.value.name}.`, payload: { name: p.value.name } });
    return id;
  });
}
export async function updateOwner(u: PortfolioActor, id: string, raw: Record<string, unknown>) {
  const p = parseOwnerInput(raw);
  if (!p.ok) throw invalid(p.error);
  await db.transaction(async (tx) => {
    const o = await loadOwner(tx, u.tenantId, id);
    await assertOwnerNameFree(tx, u.tenantId, p.value.name, id);
    const changed = (["name", "email", "notes"] as const).filter((k) => (o[k] ?? null) !== (p.value[k] ?? null));
    if (!changed.length) return;
    await tx.update(owners).set({ ...p.value, updatedAt: new Date() }).where(eq(owners.id, id));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "owner.updated", entity: "Owner", entityId: id, summary: `${u.name} modifie le propriétaire ${p.value.name}.`, payload: { changed, name: { from: o.name, to: p.value.name } } });
  });
}
export async function deleteOwner(u: PortfolioActor, id: string) {
  await db.transaction(async (tx) => {
    const o = await loadOwner(tx, u.tenantId, id);
    if (o.isDefault) throw new PortfolioError("CONFLICT", "Le propriétaire par défaut ne peut pas être supprimé : il reçoit les logements créés sans choix. Vous pouvez le renommer.");
    const [{ n }] = await tx.select({ n: count() }).from(properties).where(and(eq(properties.ownerId, id), eq(properties.tenantId, u.tenantId)));
    if (Number(n) > 0) throw new PortfolioError("CONFLICT", `${Number(n)} logement${Number(n) > 1 ? "s lui sont rattachés" : " lui est rattaché"} : changez leur propriétaire avant de le supprimer.`);
    await tx.delete(owners).where(eq(owners.id, id));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "owner.deleted", entity: "Owner", entityId: id, summary: `${u.name} supprime le propriétaire ${o.name}.`, payload: { name: o.name } });
  });
}
/** Propriétaire demandé (de cet espace, sinon refus) ou, sans demande, le propriétaire par défaut. */
async function resolveOwnerId(tx: Tx, tenantId: string, requested: unknown): Promise<string> {
  if (requested === undefined || requested === null || requested === "") return ensureDefaultOwner(tx, tenantId);
  if (typeof requested !== "string") throw invalid("Propriétaire invalide.");
  const [o] = await tx.select({ id: owners.id }).from(owners).where(and(eq(owners.id, requested), eq(owners.tenantId, tenantId)));
  if (!o) throw invalid("Ce propriétaire n'existe pas dans votre espace.");
  return o.id;
}

// ───────────────────────── Logements ─────────────────────────

async function loadProperty(ex: Ex, tenantId: string, id: string) {
  const [p] = await ex.select().from(properties).where(and(eq(properties.id, id), eq(properties.tenantId, tenantId)));
  if (!p) throw new PortfolioError("NOT_FOUND", "Logement introuvable.");
  return p;
}
const identityOf = (p: typeof properties.$inferSelect): PropertyIdentity => ({ name: p.name, city: p.city, kind: p.kind, bedrooms: p.bedrooms, capacity: p.capacity, positioning: ((p.strategy as Strategy)?.positioning ?? p.profile?.positioning ?? null) || null, objective: (p.strategy as Strategy)?.objective ?? null });

export type DraftIdentity = { name: string; city: string; kind: string; bedrooms: number | null; capacity: number | null; positioning?: string | null; objective?: string | null };
/**
 * Crée le dossier d'un logement en cours de création (statut ONBOARDING), sans connexion ni coût : tout est inconnu.
 * `how` : « next » = identité complète, passe à l'étape suivante ; « stay » = brouillon (parcours « Enregistrer et quitter »).
 * Le nom peut être vide en brouillon : « Logement sans nom ». Sert au parcours guidé et à l'API (`POST /api/v1/properties`).
 */
export async function createPropertyDraft(u: PortfolioActor, v: DraftIdentity, how: "next" | "stay", requestedOwnerId?: unknown): Promise<{ id: string; name: string }> {
  const id = newId("prop"), name = v.name || "Logement sans nom";
  const strategy: Strategy = { basePriceCents: null, minPriceCents: null, maxPriceCents: null, minStay: null, objective: v.objective ?? undefined, positioning: v.positioning ?? undefined, maxDiscountStackPct: 20, maxPriceChangePct: 5 };
  await db.transaction(async (tx) => {
    const ownerId = await resolveOwnerId(tx, u.tenantId, requestedOwnerId);
    await tx.insert(properties).values({ id, tenantId: u.tenantId, ownerId, name, city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity, status: "ONBOARDING", isDemo: false, profile: { positioning: v.positioning ?? null }, economics: emptyEconomics(), strategy, channelMarkups: [], onboarding: advance(null, "logement", how) });
    await tx.insert(schema.agentRuns).values({ id: newId("run"), tenantId: u.tenantId, agentId: "onboarding", operation: "onboard", mode: "DETERMINISTIC", summary: `${name} : création du logement commencée.` });
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.created", entity: "Property", entityId: id, summary: `${u.name} commence la création du logement ${name}.`, payload: { name, city: v.city, kind: v.kind, ownerId } });
  });
  return { id, name };
}
/** Création depuis l'API : identité complète exigée (mêmes règles que « Continuer » dans le parcours). */
export async function createProperty(u: PortfolioActor, raw: Record<string, unknown>) {
  const p = parsePropertyIdentity(raw);
  if (!p.ok) throw invalid(p.error);
  return createPropertyDraft(u, p.value, "next", raw.ownerId);
}

/** Modification de l'identité d'un logement et de son propriétaire (l'API). Coûts, stratégie et connexions ont leurs propres parcours. */
export async function updatePropertyIdentity(u: PortfolioActor, id: string, raw: Record<string, unknown>) {
  await db.transaction(async (tx) => {
    const p = await loadProperty(tx, u.tenantId, id);
    if (p.isDemo) throw invalid("Un logement de démonstration ne se modifie pas.");
    const r = parsePropertyPatch(raw, identityOf(p));
    if (!r.ok) throw invalid(r.error);
    const { identity: v, changed } = r.value;
    const ownerChanged = "ownerId" in raw;
    const ownerId = ownerChanged ? await resolveOwnerId(tx, u.tenantId, raw.ownerId) : p.ownerId;
    if (ownerChanged && ownerId !== p.ownerId) changed.push("ownerId");
    if (!changed.length) return;
    const old = p.strategy as Strategy;
    await tx.update(properties).set({
      ownerId, name: v.name, city: v.city, kind: v.kind, bedrooms: v.bedrooms, capacity: v.capacity,
      strategy: { ...old, objective: v.objective ?? undefined, positioning: v.positioning ?? undefined }, profile: { ...p.profile, positioning: v.positioning },
    }).where(eq(properties.id, p.id));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.updated", entity: "Property", entityId: p.id, summary: `${u.name} met à jour le dossier de ${v.name}.`, payload: { changed } });
  });
}

/**
 * Suppression définitive d'un logement et de tout ce qui s'y rattache (réservations, calendrier, situations, actions, annonces, clés).
 * Garde-fous : le nom doit être ressaisi, un logement de démonstration ne se supprime pas, et aucune action de revenu ne doit être en cours.
 * Le journal d'audit est conservé (ajout seul) et garde la trace de ce qui a été supprimé.
 */
export async function deleteProperty(u: PortfolioActor, id: string, confirmName: unknown) {
  await db.transaction(async (tx) => {
    const p = await loadProperty(tx, u.tenantId, id);
    if (p.isDemo) throw invalid("Un logement de démonstration ne se supprime pas.");
    if (typeof confirmName !== "string" || confirmName.trim() !== p.name) throw invalid("Pour confirmer la suppression, saisissez exactement le nom du logement.");
    const [{ n: inFlight }] = await tx.select({ n: count() }).from(schema.revenueActions).where(and(eq(schema.revenueActions.propertyId, p.id), inArray(schema.revenueActions.status, IN_FLIGHT)));
    if (Number(inFlight) > 0) throw new PortfolioError("CONFLICT", `${Number(inFlight)} action${Number(inFlight) > 1 ? "s de revenu sont" : " de revenu est"} en cours sur ce logement : terminez-les ou annulez-les avant de le supprimer.`);
    const cnt = async (t: typeof schema.reservations | typeof schema.opportunities | typeof schema.listings) => Number((await tx.select({ n: count() }).from(t as any).where(eq((t as any).propertyId, p.id)))[0].n);
    const lost = { reservations: await cnt(schema.reservations), opportunities: await cnt(schema.opportunities), listings: await cnt(schema.listings) };
    await tx.delete(properties).where(and(eq(properties.id, p.id), eq(properties.tenantId, u.tenantId)));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "property.deleted", entity: "Property", entityId: p.id, summary: `${u.name} supprime le logement ${p.name}.`, payload: { name: p.name, city: p.city, status: p.status, ...lost } });
  });
}

// ───────────────────────── Annonces ─────────────────────────

export async function listListings(tenantId: string, propertyId: string) {
  await loadProperty(db, tenantId, propertyId);
  return db.select().from(listings).where(and(eq(listings.tenantId, tenantId), eq(listings.propertyId, propertyId))).orderBy(asc(listings.channel), asc(listings.createdAt));
}
const pgConstraint = (e: unknown): { code?: string; constraint?: string } => { for (let x: any = e, i = 0; x && i < 4; x = x.cause, i++) if (x.code === "23505") return { code: x.code, constraint: x.constraint }; return {}; };

/** Message précis d'un doublon : annonce déjà reliée à un autre logement, ou deuxième annonce active sur un canal. */
async function duplicateError(e: unknown, tenantId: string, propertyId: string, channel: ListingChannel, externalId: string | null): Promise<PortfolioError | null> {
  const { constraint } = pgConstraint(e);
  if (constraint === "listings_channel_external" && externalId) {
    const [other] = await db.select({ propertyId: listings.propertyId, name: properties.name }).from(listings).innerJoin(properties, eq(properties.id, listings.propertyId)).where(and(eq(listings.tenantId, tenantId), eq(listings.channel, channel), eq(listings.externalId, externalId))).limit(1);
    return new PortfolioError("CONFLICT", other && other.propertyId !== propertyId
      ? `Cet identifiant ${LISTING_CHANNEL_LABEL[channel]} est déjà rattaché à votre logement « ${other.name} ». Une annonce ne peut désigner qu'un seul logement.`
      : `Cet identifiant ${LISTING_CHANNEL_LABEL[channel]} est déjà utilisé par une autre annonce de ce logement (peut-être archivée).`);
  }
  if (constraint === "listings_one_active_per_channel") return new PortfolioError("CONFLICT", `Ce logement a déjà une annonce active sur ${LISTING_CHANNEL_LABEL[channel]} : modifiez-la, ou archivez-la avant d'en créer une autre.`);
  return null;
}
async function loadListing(ex: Ex, tenantId: string, propertyId: string, id: string) {
  const [l] = await ex.select().from(listings).where(and(eq(listings.id, id), eq(listings.propertyId, propertyId), eq(listings.tenantId, tenantId)));
  if (!l) throw new PortfolioError("NOT_FOUND", "Annonce introuvable.");
  return l;
}
async function editableProperty(ex: Ex, tenantId: string, propertyId: string) {
  const p = await loadProperty(ex, tenantId, propertyId);
  if (p.isDemo) throw invalid("Les annonces d'un logement de démonstration ne se modifient pas.");
  return p;
}

export async function createListing(u: PortfolioActor, propertyId: string, raw: Record<string, unknown>) {
  const p = parseListingInput(raw);
  if (!p.ok) throw invalid(p.error);
  const id = newId("lst");
  try {
    await db.transaction(async (tx) => {
      const prop = await editableProperty(tx, u.tenantId, propertyId);
      await tx.insert(listings).values({ id, tenantId: u.tenantId, propertyId, ...p.value });
      await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "listing.created", entity: "Listing", entityId: id, summary: `${u.name} ajoute l'annonce ${LISTING_CHANNEL_LABEL[p.value.channel]} de ${prop.name}.`, payload: { propertyId, ...p.value } });
    });
  } catch (e) { throw (await duplicateError(e, u.tenantId, propertyId, p.value.channel, p.value.externalId)) ?? e; }
  return id;
}
export async function updateListing(u: PortfolioActor, propertyId: string, id: string, raw: Record<string, unknown>) {
  let channel: ListingChannel | null = null, externalId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      const prop = await editableProperty(tx, u.tenantId, propertyId);
      const l = await loadListing(tx, u.tenantId, propertyId, id);
      // le canal d'une annonce ne change pas : c'est une autre annonce (suppression puis création)
      const p = parseListingInput({ channel: l.channel, externalId: "externalId" in raw ? raw.externalId : l.externalId, url: "url" in raw ? raw.url : l.url, title: "title" in raw ? raw.title : l.title });
      if (!p.ok) throw invalid(p.error);
      channel = p.value.channel; externalId = p.value.externalId;
      const changed = (["externalId", "url", "title"] as const).filter((k) => (l[k] ?? null) !== (p.value[k] ?? null));
      if (!changed.length) return;
      await tx.update(listings).set({ externalId: p.value.externalId, url: p.value.url, title: p.value.title, updatedAt: new Date() }).where(eq(listings.id, id));
      await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "listing.updated", entity: "Listing", entityId: id, summary: `${u.name} modifie l'annonce ${LISTING_CHANNEL_LABEL[p.value.channel]} de ${prop.name}.`, payload: { propertyId, changed, externalId: { from: l.externalId, to: p.value.externalId } } });
    });
  } catch (e) { if (channel) { const d = await duplicateError(e, u.tenantId, propertyId, channel, externalId); if (d) throw d; } throw e; }
}
export async function setListingStatus(u: PortfolioActor, propertyId: string, id: string, status: "ACTIVE" | "ARCHIVED") {
  let channel: ListingChannel | null = null;
  try {
    await db.transaction(async (tx) => {
      const prop = await editableProperty(tx, u.tenantId, propertyId);
      const l = await loadListing(tx, u.tenantId, propertyId, id);
      channel = l.channel as ListingChannel;
      if (l.status === status) return;
      await tx.update(listings).set({ status, updatedAt: new Date() }).where(eq(listings.id, id));
      await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: status === "ARCHIVED" ? "listing.archived" : "listing.restored", entity: "Listing", entityId: id, summary: `${u.name} ${status === "ARCHIVED" ? "archive" : "rétablit"} l'annonce ${LISTING_CHANNEL_LABEL[l.channel as ListingChannel]} de ${prop.name}.`, payload: { propertyId } });
    });
  } catch (e) { if (channel) { const d = await duplicateError(e, u.tenantId, propertyId, channel, null); if (d) throw d; } throw e; }
}
export async function deleteListing(u: PortfolioActor, propertyId: string, id: string) {
  await db.transaction(async (tx) => {
    const prop = await editableProperty(tx, u.tenantId, propertyId);
    const l = await loadListing(tx, u.tenantId, propertyId, id);
    await tx.delete(listings).where(eq(listings.id, id));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "listing.deleted", entity: "Listing", entityId: id, summary: `${u.name} supprime l'annonce ${LISTING_CHANNEL_LABEL[l.channel as ListingChannel]} de ${prop.name}.`, payload: { propertyId, channel: l.channel, externalId: l.externalId } });
  });
}

// ───────────────────────── Espace (Tenant) ─────────────────────────

/** Nom de l'espace. La suppression d'un espace entier relève de l'US-123 (RGPD : rétention et suppression). */
export async function renameTenant(u: PortfolioActor, raw: unknown) {
  const p = parseTenantName(raw);
  if (!p.ok) throw invalid(p.error);
  await db.transaction(async (tx) => {
    const [t] = await tx.select({ name: schema.tenants.name }).from(schema.tenants).where(eq(schema.tenants.id, u.tenantId));
    if (!t) throw new PortfolioError("NOT_FOUND", "Espace introuvable.");
    if (t.name === p.value) return;
    await tx.update(schema.tenants).set({ name: p.value }).where(eq(schema.tenants.id, u.tenantId));
    await recordAudit(tx, { tenantId: u.tenantId, actor: userActor(u.id), type: "tenant.renamed", entity: "Tenant", entityId: u.tenantId, summary: `${u.name} renomme l'espace « ${t.name} » en « ${p.value} ».`, payload: { from: t.name, to: p.value } });
  });
}
