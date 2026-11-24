import type { OnboardingState } from "@/lib/onboarding";
import { sql } from "drizzle-orm";
import { pgTable, text, integer, bigserial, boolean, timestamp, jsonb, date, real, numeric, primaryKey, index, uniqueIndex } from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();

export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull(),
  /** Réglages : autonomie, prénoms d'agents, ancrage de la démonstration */
  settings: jsonb("settings").$type<Record<string, any>>().notNull().default({}),
  createdAt: created(),
});

export const users = pgTable("users", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("OWNER"),
  createdAt: created(),
});

export const sessions = pgTable("sessions", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  /** Dernière saisie du mot de passe dans cette session. Vide si la session vient d'un jeton « Rester connecté » : les actions sensibles (clés API) redemandent alors le mot de passe. */
  passwordVerifiedAt: ts("password_verified_at"),
  createdAt: created(),
});

/** Jetons « Rester connecté » : seul le hash SHA-256 est conservé. Un jeton change à chaque utilisation (même `familyId`) ; un jeton déjà utilisé qui revient révoque toute la famille. */
export const rememberTokens = pgTable("remember_tokens", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  familyId: text("family_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("remember_tokens_hash").on(t.tokenHash), index("remember_tokens_user").on(t.userId), index("remember_tokens_family").on(t.familyId)]);

/** Propriétaire du bien (identité commerciale, US-020) : un espace peut en regrouper plusieurs ; exactement un est « par défaut » (il reçoit les logements créés sans choix). */
export const owners = pgTable("owners", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  notes: text("notes"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("owners_tenant").on(t.tenantId), uniqueIndex("owners_one_default").on(t.tenantId).where(sql`is_default`), uniqueIndex("owners_name_ci").on(t.tenantId, sql`lower(${t.name})`)]);

export const properties = pgTable("properties", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Propriétaire du bien (US-020). Un propriétaire qui possède des logements ne peut pas être supprimé. */
  ownerId: text("owner_id").references(() => owners.id),
  name: text("name").notNull(),
  city: text("city").notNull(),
  kind: text("kind").notNull(),
  bedrooms: integer("bedrooms"),
  capacity: integer("capacity"),
  /** ONBOARDING | SHADOW | ACTIVE */
  status: text("status").notNull().default("ONBOARDING"),
  isDemo: boolean("is_demo").notNull().default(false),
  profile: jsonb("profile").$type<Record<string, any>>().notNull().default({}),
  /** Modèle économique : commissions, frais, coûts, contribution cible */
  economics: jsonb("economics").$type<Record<string, any>>().notNull().default({}),
  /** Stratégie : base / min / max, séjour minimum, objectifs */
  strategy: jsonb("strategy").$type<Record<string, any>>().notNull().default({}),
  strategyVersion: integer("strategy_version").notNull().default(1),
  /** Connexion PriceLabs propre au logement : clé chiffrée, annonce rattachée, état de la dernière lecture */
  pricelabs: jsonb("pricelabs").$type<Record<string, any>>(),
  /** Connexion SuperHote (lecture seule) propre au logement : jeton chiffré, logement rattaché, canaux relevés, comparaison de prix */
  superhote: jsonb("superhote").$type<Record<string, any>>(),
  /** Brouillon du Strategy Builder (US-023) : réglages proposés, version de la stratégie sur laquelle il repose, auteur, date. null = pas de brouillon. */
  strategyDraft: jsonb("strategy_draft").$type<{ values: Record<string, unknown>; baseVersion: number; baseValues?: Record<string, unknown>; by: string; at: string }>(),
  /** Numéro de la version courante du modèle économique (US-022) ; 0 = aucune version enregistrée. Les versions sont dans economic_model_versions. */
  economicsVersion: integer("economics_version").notNull().default(0),
  /** Confirmation du mapping des identifiants externes (US-021) : { fingerprint, at, by, warnings }. Périmée dès que l'empreinte des identifiants change. */
  mapping: jsonb("mapping").$type<{ fingerprint: string; at: string; by: string; warnings: string[] }>(),
  /** Majorations SuperHote par canal, saisies par le propriétaire : [{ key, label, pct }], pct null = inconnue */
  channelMarkups: jsonb("channel_markups").$type<{ key: string; label: string; pct: number | null }[]>().notNull().default([]),
  /** Parcours de création (funnel) : étape où reprendre, étapes validées et reportées, heure du dernier enregistrement « à faire plus tard ». null = logement créé avant le funnel ou parcours terminé */
  onboarding: jsonb("onboarding").$type<OnboardingState>(),
  /** Rythme de suivi adaptatif : palier, raisons, intervalles, dernier passage, relevé de marché de référence, échecs de lecture */
  cadence: jsonb("cadence").$type<Record<string, any>>(),
  /** Prochaines échéances du planificateur ; null = à faire dès que la source est connectée */
  nextReservationsAt: ts("next_reservations_at"),
  nextPricesAt: ts("next_prices_at"),
  nextReviewAt: ts("next_review_at"),
  createdAt: created(),
}, (t) => [index("properties_tenant").on(t.tenantId)]);

/**
 * Annonce d'un logement sur un canal (US-020) : Airbnb, Booking.com ou direct. L'identifiant du canal (`externalId`) est facultatif ;
 * une fois renseigné, il ne peut désigner qu'un seul logement de l'espace. Un logement a au plus une annonce ACTIVE par canal Airbnb ou Booking.
 */
export const listings = pgTable("listings", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  /** AIRBNB | BOOKING | DIRECT */
  channel: text("channel").notNull(),
  externalId: text("external_id"),
  url: text("url"),
  title: text("title"),
  /** ACTIVE | ARCHIVED */
  status: text("status").notNull().default("ACTIVE"),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  index("listings_property").on(t.tenantId, t.propertyId),
  uniqueIndex("listings_channel_external").on(t.tenantId, t.channel, t.externalId).where(sql`external_id is not null`),
  uniqueIndex("listings_one_active_per_channel").on(t.propertyId, t.channel).where(sql`status = 'ACTIVE' and channel in ('AIRBNB', 'BOOKING')`),
]);

export const reservations = pgTable("reservations", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  channel: text("channel").notNull(),
  checkIn: date("check_in", { mode: "string" }).notNull(),
  checkOut: date("check_out", { mode: "string" }).notNull(),
  nights: integer("nights").notNull(),
  /** Centimes — hébergement après remise, hors ménage et taxes */
  grossRoomCents: integer("gross_room_cents").notNull(),
  cleaningCents: integer("cleaning_cents"),
  commissionCents: integer("commission_cents"),
  paymentFeeCents: integer("payment_fee_cents"),
  status: text("status").notNull().default("CONFIRMED"),
  bookedAt: date("booked_at", { mode: "string" }).notNull(),
  source: text("source").notNull().default("DEMO"),
  /** Dernière modification connue chez la source (`updated_at` SuperHote) : un événement plus ancien que celle-ci est ignoré (US-031). null = inconnue. */
  sourceUpdatedAt: ts("source_updated_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("reservations_ext").on(t.propertyId, t.externalId), index("reservations_prop").on(t.tenantId, t.propertyId, t.checkIn)]);

/**
 * Allocation d'une réservation sur ses nuits (US-031, blueprint §12.2 « Reservation 1─* ReservationNight »). Une ligne par nuit vendue ou bloquée ;
 * une réservation annulée ou doublon n'a aucune nuit (ses dates sont rouvertes). La somme des nuits égale toujours le montant de la réservation
 * (reste réparti, un centime par nuit, sur les premières nuits). Le ménage n'est pas alloué : il n'est pas du revenu d'hébergement.
 */
export const reservationNights = pgTable("reservation_nights", {
  reservationId: text("reservation_id").notNull().references(() => reservations.id, { onDelete: "cascade" }),
  night: date("night", { mode: "string" }).notNull(),
  tenantId: text("tenant_id").notNull(),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  /** CONFIRMED | BLOCKED */
  status: text("status").notNull(),
  grossRoomCents: integer("gross_room_cents").notNull(),
  commissionCents: integer("commission_cents"),
  paymentFeeCents: integer("payment_fee_cents"),
}, (t) => [primaryKey({ columns: [t.reservationId, t.night] }), index("reservation_nights_property_night").on(t.propertyId, t.night), index("reservation_nights_tenant").on(t.tenantId)]);

/**
 * Historique des changements d'une réservation (US-031, blueprint §12.4) : création, modification, annulation, réactivation, avec ce qui a changé.
 * Rattaché à (logement, identifiant externe) et non à la ligne de réservation, que la relecture complète recrée. Jamais modifié ni supprimé
 * par l'application (le rôle applicatif n'a que SELECT et INSERT). Aucune donnée de voyageur : seulement dates, canal, statut et montants.
 */
export const reservationChanges = pgTable("reservation_changes", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  /** CREATED | MODIFIED | CANCELLED | REACTIVATED */
  kind: text("kind").notNull(),
  /** WEBHOOK | RECONCILE */
  source: text("source").notNull(),
  /** Identifiant de livraison SuperHote (`X-Superhote-Delivery`) quand le changement vient d'un webhook. */
  deliveryId: text("delivery_id"),
  /** Date de la modification chez la source. */
  occurredAt: ts("occurred_at"),
  before: jsonb("before").$type<Record<string, any> | null>(),
  after: jsonb("after").$type<Record<string, any>>().notNull(),
  changes: jsonb("changes").$type<{ key: string; label: string; from: string | null; to: string | null }[]>().notNull().default([]),
  createdAt: created(),
}, (t) => [index("reservation_changes_property").on(t.propertyId, t.createdAt), index("reservation_changes_resa").on(t.propertyId, t.externalId, t.createdAt), index("reservation_changes_tenant").on(t.tenantId)]);

/**
 * Point de réception des webhooks SuperHote (US-030). Un compte SuperHote n'accepte que 10 webhooks : on en crée UN par propriétaire et par jeton,
 * et la livraison est aiguillée vers le logement par `rental_id`. L'identifiant (`id`) est opaque et fait partie de l'URL publique ; le secret
 * `whsec_…`, renvoyé une seule fois par SuperHote à la création, est chiffré (AES-256-GCM) et sert à vérifier la signature HMAC de chaque livraison.
 */
export const superhoteWebhooks = pgTable("superhote_webhooks", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** Empreinte (HMAC) du jeton API : relie les logements qui partagent le même compte SuperHote, sans stocker le jeton. */
  tokenFingerprint: text("token_fingerprint").notNull(),
  /** Identifiant du webhook chez SuperHote (pour le supprimer). */
  remoteId: text("remote_id").notNull(),
  secretEnc: text("secret_enc").notNull(),
  url: text("url").notNull(),
  events: jsonb("events").$type<string[]>().notNull().default([]),
  lastReceivedAt: ts("last_received_at"),
  createdBy: text("created_by").notNull(),
  createdAt: created(),
}, (t) => [uniqueIndex("superhote_webhooks_token").on(t.tenantId, t.tokenFingerprint), index("superhote_webhooks_tenant").on(t.tenantId)]);

/**
 * Boîte de réception des livraisons (US-030) : chaque livraison reçue y est inscrite AVANT tout traitement, sous la clé d'idempotence
 * `X-Superhote-Delivery` (une nouvelle tentative de SuperHote garde le même identifiant). Le corps n'est conservé qu'après filtrage par liste blanche
 * (aucune donnée du voyageur, US-034). Statuts : RECEIVED (inscrite, pas encore traitée) · PROCESSING (réclamée) · PROCESSED · IGNORED (événement ou logement hors périmètre) · FAILED (à rejouer, US-033).
 */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  /** null après la suppression du point de réception : l'historique des livraisons est conservé. */
  endpointId: text("endpoint_id").references(() => superhoteWebhooks.id, { onDelete: "set null" }),
  deliveryId: text("delivery_id").notNull(),
  event: text("event").notNull(),
  propertyId: text("property_id").references(() => properties.id, { onDelete: "set null" }),
  /** Identifiant de la réservation SuperHote concernée. */
  externalId: text("external_id"),
  status: text("status").notNull().default("RECEIVED"),
  /** Résultat du traitement : CREATED | MODIFIED | CANCELLED | REACTIVATED | UNCHANGED | STALE, ou la raison d'un IGNORED. */
  outcome: text("outcome"),
  attempts: integer("attempts").notNull().default(0),
  error: text("error"),
  payload: jsonb("payload").$type<Record<string, any>>().notNull().default({}),
  /** Début du traitement en cours (statut PROCESSING) : une livraison n'est traitée que par celui qui la « réclame », et une réclamation de plus d'une minute est considérée abandonnée. */
  claimedAt: ts("claimed_at"),
  receivedAt: ts("received_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
}, (t) => [uniqueIndex("webhook_deliveries_unique").on(t.endpointId, t.deliveryId), index("webhook_deliveries_status").on(t.tenantId, t.status, t.receivedAt), index("webhook_deliveries_tenant").on(t.tenantId)]);

export const calendarDays = pgTable("calendar_days", {
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  tenantId: text("tenant_id").notNull(),
  /** Prix publié par PriceLabs, centimes. null = inconnu */
  priceCents: integer("price_cents"),
  /** `price` PriceLabs : prix recommandé, centimes. null = inconnu */
  recommendedPriceCents: integer("recommended_price_cents"),
  /** `user_price` PriceLabs : prix envoyé à SuperHote, centimes. null = inconnu, réservé ou bloqué (−1) */
  sentPriceCents: integer("sent_price_cents"),
  minStay: integer("min_stay"),
  /** FREE | BOOKED | BLOCKED */
  state: text("state").notNull(),
  rule: text("rule"),
  observedAt: ts("observed_at").notNull().defaultNow(),
  /** Lineage (US-043) : snapshot d'où vient cette ligne. null = ligne antérieure aux snapshots ou issue d'une autre source. */
  snapshotId: text("snapshot_id"),
}, (t) => [primaryKey({ columns: [t.propertyId, t.date] })]);

export const marketDays = pgTable("market_days", {
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  tenantId: text("tenant_id").notNull(),
  marketOccupancy: real("market_occupancy"),
  marketAdrCents: integer("market_adr_cents"),
  pricePercentile: integer("price_percentile"),
  event: text("event"),
  observedAt: ts("observed_at").notNull().defaultNow(),
  /** Lineage (US-043) : snapshot d'où vient cette ligne. */
  snapshotId: text("snapshot_id"),
}, (t) => [primaryKey({ columns: [t.propertyId, t.date] })]);

/**
 * Snapshot immuable d'une lecture externe (US-043, blueprint §7.4, §8.1, §12.4) : ce que la source a répondu, à quel moment, avec quelle qualité.
 * Jamais modifié ni supprimé par l'application (le rôle applicatif n'a que SELECT et INSERT). Une lecture identique à la précédente n'est pas dupliquée :
 * elle crée une ligne sans payload qui pointe la première (`unchangedOf`) et fait avancer la fraîcheur.
 */
export const sourceSnapshots = pgTable("source_snapshots", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  /** PRICING | MARKET */
  kind: text("kind").notNull(),
  /** PRICELABS */
  source: text("source").notNull(),
  /** HTTP | FAKE | REPLAY : jamais d'ambiguïté sur l'origine réelle ou simulée. */
  adapter: text("adapter").notNull(),
  observedAt: ts("observed_at").notNull(),
  validFrom: date("valid_from", { mode: "string" }),
  validTo: date("valid_to", { mode: "string" }),
  contentHash: text("content_hash").notNull(),
  unchangedOf: text("unchanged_of"),
  /** Réponse brute de la source (sans clé ni secret). null quand la lecture est identique à `unchangedOf`. */
  payload: jsonb("payload").$type<unknown>(),
  /** 0 à 100 : part des données exploitables. */
  qualityScore: integer("quality_score").notNull(),
  lineage: jsonb("lineage").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: created(),
}, (t) => [index("source_snapshots_latest").on(t.propertyId, t.kind, t.observedAt), index("source_snapshots_tenant").on(t.tenantId)]);

export const promotions = pgTable("promotions", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  discountPct: real("discount_pct").notNull(),
  stayFrom: date("stay_from", { mode: "string" }),
  stayTo: date("stay_to", { mode: "string" }),
  /** ACTIVE | ENDED | PLANNED */
  status: text("status").notNull().default("ACTIVE"),
  source: text("source").notNull().default("MANUAL"),
  verifiedAt: ts("verified_at"),
  createdAt: created(),
  /** US-100 : annonce du canal visée (null = toutes les annonces du canal pour ce logement). Référence souple : l'annonce peut être archivée sans effacer l'historique. */
  listingId: text("listing_id"),
  /** US-100 : fenêtre de réservation (dates auxquelles le voyageur doit réserver), bornes incluses ; null = toujours */
  bookFrom: date("book_from", { mode: "string" }),
  bookTo: date("book_to", { mode: "string" }),
  /** US-100 : durée de séjour minimale exigée par la promotion, en nuits (null = aucune) */
  minLos: integer("min_los"),
  /** US-100 : ALL | MOBILE | MEMBERS | COUNTRY (déduit du type de promotion) */
  audience: text("audience").notNull().default("ALL"),
  /** US-100 : identifiant de la promotion relevé dans l'extranet du canal */
  externalRef: text("external_ref"),
  /** US-100 : qui a déclaré la promotion, qui l'a vérifiée en dernier */
  createdBy: text("created_by"),
  verifiedBy: text("verified_by"),
  /** US-103 : action approuvée dont cette promotion est issue (null = déclarée à la main dans le registre) */
  actionId: text("action_id"),
  /** US-103 : date d'entrée en vigueur déclarée par l'opérateur (jour où la promotion a été posée dans l'extranet) */
  effectiveOn: date("effective_on", { mode: "string" }),
  /** US-103 : preuve saisie par l'opérateur (numéro de confirmation, lien vers une capture) ; du texte, jamais une instruction */
  proof: text("proof"),
  /** US-100 : fin de la promotion (quand elle est terminée) et pourquoi */
  endedAt: ts("ended_at"),
  endReason: text("end_reason"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("promotions_prop").on(t.tenantId, t.propertyId), uniqueIndex("promotions_action_id_uniq").on(t.actionId).where(sql`action_id is not null`)]);

export const opportunities = pgTable("opportunities", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  playbook: text("playbook").notNull(),
  reasonCode: text("reason_code").notNull(),
  title: text("title").notNull(),
  stayFrom: date("stay_from", { mode: "string" }).notNull(),
  stayTo: date("stay_to", { mode: "string" }).notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  signals: jsonb("signals").$type<any>().notNull(),
  diagnosis: jsonb("diagnosis").$type<any>().notNull(),
  /** Options instruites : paramètres, simulation, audit */
  candidates: jsonb("candidates").$type<any[]>().notNull(),
  selected: integer("selected").notNull().default(0),
  priority: real("priority").notNull().default(0),
  confidence: real("confidence").notNull().default(0),
  risk: text("risk").notNull().default("LOW"),
  /** Impact net simulé de l'option retenue ; null = non chiffrable */
  impactCents: integer("impact_cents"),
  veto: boolean("veto").notNull().default(false),
  /** OPEN | DECIDED | DEFERRED | EXPIRED */
  status: text("status").notNull().default("OPEN"),
  decision: text("decision"),
  deferUntil: date("defer_until", { mode: "string" }),
  /** Date de la décision humaine : point de départ de la période de repos du playbook (US-061). Remise à null à la réouverture. */
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** Regroupement (US-061) : les dossiers d'un même logement dont les nuits se touchent partagent cette clé. */
  groupKey: text("group_key"),
  narrative: jsonb("narrative").$type<any>(),
  createdAt: created(),
  expiresAt: date("expires_at", { mode: "string" }).notNull(),
}, (t) => [uniqueIndex("opps_code").on(t.tenantId, t.code), index("opps_status").on(t.tenantId, t.status), index("opps_dedupe").on(t.tenantId, t.dedupeKey), index("opps_group").on(t.tenantId, t.propertyId, t.groupKey)]);

export const revenueActions = pgTable("revenue_actions", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  opportunityId: text("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  label: text("label").notNull(),
  target: jsonb("target").$type<any>().notNull(),
  parameters: jsonb("parameters").$type<any>().notNull(),
  simulation: jsonb("simulation").$type<any>().notNull(),
  audit: jsonb("audit").$type<any>().notNull(),
  /** Machine à états du blueprint §6.6 */
  status: text("status").notNull(),
  riskLevel: text("risk_level").notNull(),
  rollbackPlan: text("rollback_plan").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  approvalComment: text("approval_comment"),
  approvedById: text("approved_by_id"),
  approvedAt: ts("approved_at"),
  executedAt: ts("executed_at"),
  /** US-094 : dernière relecture chez PriceLabs pour détecter une dérive (jamais plus d'une fois par période) */
  driftCheckedAt: ts("drift_checked_at"),
  execution: jsonb("execution").$type<any>(),
  verifiedAt: ts("verified_at"),
  measureDueAt: date("measure_due_at", { mode: "string" }),
  measurement: jsonb("measurement").$type<any>(),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("actions_status").on(t.tenantId, t.status)]);

/** Historique des transitions d'état d'une action (US-065), écrit par un déclencheur de la base : aucune transition ne peut manquer. */
export const actionTransitions = pgTable("action_transitions", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  actionId: text("action_id").notNull().references(() => revenueActions.id, { onDelete: "cascade" }),
  /** null = création de l'action */
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  createdAt: created(),
}, (t) => [index("action_transitions_action").on(t.actionId, t.createdAt)]);

export const agentRuns = pgTable("agent_runs", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  agentId: text("agent_id").notNull(),
  opportunityId: text("opportunity_id"),
  operation: text("operation").notNull(),
  /** LLM | DETERMINISTIC */
  mode: text("mode").notNull(),
  model: text("model"),
  promptVersion: text("prompt_version"),
  /** US-074 : trace d'un appel de modèle. Fournisseur, prompt (identifiant, version, empreinte), nombre d'appels, correction, cause du repli et cibles essayées. */
  provider: text("provider"),
  promptId: text("prompt_id"),
  promptHash: text("prompt_hash"),
  attempts: integer("attempts"),
  repaired: boolean("repaired"),
  /** NO_PROVIDER | BUDGET_CALLS | BUDGET_TOKENS | BUDGET | PROVIDER_ERROR | INVALID_OUTPUT : pourquoi la version déterministe a été utilisée */
  fallbackReason: text("fallback_reason"),
  trace: jsonb("trace").$type<any>(),
  summary: text("summary").notNull(),
  output: jsonb("output").$type<any>(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  durationMs: integer("duration_ms").notNull().default(0),
  error: text("error"),
  /** Routeur LLM (PR 1) : coût réel de l'appel en USD (tous les essais, corrections comprises), au prix validé du jour ; null = prix inconnu. Jamais inventé. */
  costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
  /** Coût estimé avant l'appel par le routeur (renseigné à partir de la PR 2) */
  costEstimatedUsd: numeric("cost_estimated_usd", { precision: 14, scale: 6 }),
  /** Instantané de prix appliqué au modèle finalement retenu */
  priceSnapshotId: text("price_snapshot_id"),
  createdAt: created(),
}, (t) => [index("runs_agent").on(t.tenantId, t.agentId, t.createdAt), index("runs_opp").on(t.opportunityId)]);

export const auditEvents = pgTable("audit_events", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  actor: text("actor").notNull(),
  type: text("type").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  summary: text("summary").notNull(),
  payload: jsonb("payload").$type<any>(),
  createdAt: created(),
}, (t) => [index("audit_tenant").on(t.tenantId, t.createdAt), index("audit_entity").on(t.tenantId, t.entity, t.entityId, t.createdAt)]);

export const integrations = pgTable("integrations", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  provider: text("provider").notNull(),
  /** DEMO | CONNECTED | NOT_CONNECTED | DEGRADED */
  status: text("status").notNull(),
  capabilities: jsonb("capabilities").$type<Record<string, boolean>>().notNull(),
  killSwitch: boolean("kill_switch").notNull().default(false),
  lastSyncAt: ts("last_sync_at"),
  note: text("note"),
}, (t) => [uniqueIndex("integrations_provider").on(t.tenantId, t.provider)]);

/** Drapeaux de fonctionnalité (US-013) : une ligne par drapeau coupé ou rétabli, à un niveau (propriétaire, logement, intégration). Voir lib/flags/catalog.ts */
export const featureFlags = pgTable("feature_flags", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  flag: text("flag").notNull(),
  /** TENANT | PROPERTY | INTEGRATION */
  scope: text("scope").notNull(),
  /** Vide pour le propriétaire, identifiant du logement, ou fournisseur */
  scopeId: text("scope_id").notNull().default(""),
  enabled: boolean("enabled").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("feature_flags_key").on(t.tenantId, t.flag, t.scope, t.scopeId)]);

/** Clé API LLM propre à chaque propriétaire (chiffrée) + cache de la liste des modèles que cette clé peut utiliser */
export const llmCredentials = pgTable("llm_credentials", {
  tenantId: text("tenant_id").primaryKey().references(() => tenants.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("anthropic"),
  apiKeyEnc: text("api_key_enc").notNull(),
  keyHint: text("key_hint").notNull(),
  models: jsonb("models").$type<{ id: string; name: string; createdAt: string | null }[]>().notNull().default([]),
  modelsFetchedAt: ts("models_fetched_at"),
  verifiedAt: ts("verified_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const reviewRuns = pgTable("review_runs", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  kind: text("kind").notNull().default("DAILY"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  steps: jsonb("steps").$type<any[]>().notNull().default([]),
  stats: jsonb("stats").$type<Record<string, any>>().notNull().default({}),
}, (t) => [index("reviews_tenant").on(t.tenantId, t.startedAt)]);

export const chatMessages = pgTable("chat_messages", {
  id: id(),
  tenantId: text("tenant_id").notNull(),
  agentId: text("agent_id").notNull(),
  opportunityId: text("opportunity_id"),
  role: text("role").notNull(),
  content: text("content").notNull(),
  mode: text("mode"),
  createdAt: created(),
}, (t) => [index("chat_agent").on(t.tenantId, t.agentId, t.createdAt)]);

/** Liens de réinitialisation du mot de passe : seul le hash SHA-256 du jeton est conservé, jamais le jeton lui-même. */
export const passwordResets = pgTable("password_resets", {
  id: id(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("password_resets_token").on(t.tokenHash), index("password_resets_user").on(t.userId)]);

/** Tentatives sensibles (demande de lien, essai de réinitialisation) pour la limitation de débit. La clé est un hash : aucune adresse e-mail ni IP en clair. */
export const authAttempts = pgTable("auth_attempts", {
  id: id(),
  kind: text("kind").notNull(),
  keyHash: text("key_hash").notNull(),
  createdAt: created(),
}, (t) => [index("auth_attempts_lookup").on(t.kind, t.keyHash, t.createdAt)]);

/** Inscriptions en attente de confirmation par e-mail : le compte n'existe qu'après clic sur le lien. Seul le hash du jeton est conservé. */
export const signupConfirmations = pgTable("signup_confirmations", {
  id: id(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: created(),
}, (t) => [uniqueIndex("signup_confirmations_token").on(t.tokenHash), index("signup_confirmations_email").on(t.email)]);

/**
 * Versions du modèle économique d'un logement (US-022) : commissions, frais de paiement, coûts, seuils, taxe de séjour.
 * Chaque changement crée une version horodatée avec son auteur et la liste de ce qui a changé ; une version n'est jamais modifiée
 * ni supprimée par l'application (le rôle applicatif n'a que SELECT et INSERT). Les montants sont en centimes, les pourcentages en %.
 */
export const economicModelVersions = pgTable("economic_model_versions", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  /** Modèle complet à cette version (sans les réponses brutes du parcours). */
  model: jsonb("model").$type<Record<string, any>>().notNull(),
  /** Ce qui a changé par rapport à la version précédente : [{ key, label, from, to }] (texte lisible, null = inconnu). */
  changes: jsonb("changes").$type<{ key: string; label: string; from: string | null; to: string | null }[]>().notNull().default([]),
  /** Auteur : identifiant de l'utilisateur, ou « system » (reprise des logements existants). */
  createdBy: text("created_by").notNull(),
  createdAt: created(),
}, (t) => [uniqueIndex("economic_versions_property_version").on(t.propertyId, t.version), index("economic_versions_tenant").on(t.tenantId)]);

/**
 * Versions de la stratégie d'un logement (US-023) : prix de base, minimum, maximum, séjour minimum, objectif, positionnement, garde-fous.
 * Une version naît à chaque changement, quelle qu'en soit l'origine (Strategy Builder, formulaire du dossier, relecture PriceLabs,
 * action approuvée, restauration). Jamais modifiée ni supprimée par l'application (le rôle applicatif n'a que SELECT et INSERT).
 */
export const strategyVersions = pgTable("strategy_versions", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  /** Même numéro que properties.strategy_version au moment de la version. */
  version: integer("version").notNull(),
  strategy: jsonb("strategy").$type<Record<string, any>>().notNull(),
  changes: jsonb("changes").$type<{ key: string; label: string; from: string | null; to: string | null }[]>().notNull().default([]),
  /** BUILDER | FORM | PRICELABS_SYNC | ACTION | ACTION_ROLLBACK | ROLLBACK | SYSTEM */
  source: text("source").notNull(),
  /** Auteur : identifiant de l'utilisateur, ou « system ». */
  createdBy: text("created_by").notNull(),
  note: text("note"),
  createdAt: created(),
}, (t) => [uniqueIndex("strategy_versions_property_version").on(t.propertyId, t.version), index("strategy_versions_tenant").on(t.tenantId)]);

/**
 * Validations humaines nécessaires à l'activation d'un logement (US-024) : floors validés, échantillon de réservations rapproché.
 * Ajout seul : on ne modifie ni ne supprime une validation, la dernière de chaque type fait foi.
 */
export const activationValidations = pgTable("activation_validations", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  /** FLOORS | RECONCILIATION */
  kind: text("kind").notNull(),
  /** FLOORS : empreinte de la grille de planchers validée. RECONCILIATION : vide. */
  fingerprint: text("fingerprint"),
  /** FLOORS : la grille validée. RECONCILIATION : { sampleSize, maxGapPct, source, note }. */
  payload: jsonb("payload").$type<Record<string, any>>().notNull(),
  validatedBy: text("validated_by").notNull(),
  validatedByName: text("validated_by_name").notNull(),
  note: text("note"),
  createdAt: created(),
}, (t) => [index("activation_validations_property_kind").on(t.propertyId, t.kind, t.createdAt), index("activation_validations_tenant").on(t.tenantId)]);

/**
 * Journal des écritures vers un fournisseur externe (US-090, blueprint §11.4 idempotence, §12.3 `ExecutionAttempt`). Une ligne par tentative d'écriture
 * (application ou retour arrière d'une action), créée AVANT l'appel et mise à jour après : une panne au milieu laisse une trace lisible, et la clé
 * d'idempotence (unique) empêche d'envoyer deux fois la même écriture. Jamais de clé API ni de donnée personnelle dans `plan` ni `receipt`.
 */
export const externalWrites = pgTable("external_writes", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  actionId: text("action_id").notNull().references(() => revenueActions.id, { onDelete: "cascade" }),
  /** `<actionId>:APPLY` ou `<actionId>:ROLLBACK` : une seule écriture de chaque sorte par action */
  idempotencyKey: text("idempotency_key").notNull().unique(),
  /** APPLY | ROLLBACK */
  phase: text("phase").notNull(),
  provider: text("provider").notNull().default("pricelabs"),
  /** LISTING_LIMITS | OVERRIDES_SET | OVERRIDES_DELETE | OVERRIDES_RESTORE */
  kind: text("kind").notNull(),
  /** PENDING (créée, rien d'envoyé de sûr) | SENT (acceptée par le fournisseur, pas encore relue) | CONFIRMED (relue et conforme) | FAILED */
  status: text("status").notNull(),
  /** Ce qu'on a voulu écrire : valeurs cibles, dates (sans clé ni secret) */
  plan: jsonb("plan").$type<Record<string, any>>().notNull(),
  /** Reçu du fournisseur : méthode, chemin, statut HTTP, empreinte du corps, date d'envoi */
  receipt: jsonb("receipt").$type<Record<string, any>>(),
  /** US-092 : instantané de l'état chez PriceLabs juste avant l'envoi, et relu juste après (limites, grille et prix datés sur les dates visées), avec leur empreinte SHA-256. Jamais de clé ni de donnée de voyageur. */
  stateBefore: jsonb("state_before").$type<Record<string, unknown>>(),
  stateAfter: jsonb("state_after").$type<Record<string, unknown>>(),
  stateBeforeHash: text("state_before_hash"),
  stateAfterHash: text("state_after_hash"),
  /** Message lisible de l'échec, jamais le texte brut d'une réponse */
  error: text("error"),
  /** HTTP | FAKE : jamais d'ambiguïté sur l'origine réelle ou simulée */
  adapter: text("adapter").notNull(),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("external_writes_action").on(t.actionId), index("external_writes_tenant").on(t.tenantId, t.createdAt)]);

/** US-094 : alertes d'exécution PriceLabs (échec, écriture non confirmée, retour arrière en échec, dérive, exécution bloquée). */
export const executionAlerts = pgTable("execution_alerts", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").references(() => properties.id, { onDelete: "cascade" }),
  actionId: text("action_id").references(() => revenueActions.id, { onDelete: "cascade" }),
  writeId: text("write_id"),
  /** WRITE_FAILED | WRITE_UNCONFIRMED | ROLLBACK_FAILED | PRECONDITION_FAILED | DRIFT | STUCK */
  kind: text("kind").notNull(),
  /** CRITICAL | WARNING */
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  /** Texte lisible : jamais de clé API ni de donnée de voyageur */
  detail: text("detail").notNull(),
  /** Une seule alerte non résolue par clé (ex. `DRIFT:<action>:<empreinte des écarts>`) */
  dedupeKey: text("dedupe_key").notNull(),
  /** OPEN | ACKNOWLEDGED | RESOLVED */
  status: text("status").notNull().default("OPEN"),
  notifiedAt: ts("notified_at"),
  acknowledgedBy: text("acknowledged_by"),
  acknowledgedAt: ts("acknowledged_at"),
  resolvedAt: ts("resolved_at"),
  resolution: text("resolution"),
  createdAt: created(),
}, (t) => [
  index("execution_alerts_tenant").on(t.tenantId, t.status, t.createdAt),
  index("execution_alerts_action").on(t.actionId),
  uniqueIndex("execution_alerts_open_dedupe").on(t.tenantId, t.dedupeKey).where(sql`status <> 'RESOLVED'`),
]);

/** US-102 : étapes cochées du guide pas-à-pas d'une action appliquée à la main. Une ligne = une étape faite (qui, quand) ; décocher supprime la ligne, l'audit garde la trace. */
export const runbookSteps = pgTable("runbook_steps", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  actionId: text("action_id").notNull().references(() => revenueActions.id, { onDelete: "cascade" }),
  /** Identifiant stable de l'étape (voir `promotions/runbook.ts`) */
  stepId: text("step_id").notNull(),
  doneBy: text("done_by").notNull(),
  doneAt: ts("done_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("runbook_steps_unique").on(t.actionId, t.stepId), index("runbook_steps_tenant").on(t.tenantId, t.actionId)]);

/**
 * US-110 : une expérience par action exécutée (blueprint §12.1 « RevenueAction 0─1 Experiment 1─* Measurement »).
 * Elle fige la baseline AVANT l'effet de l'action (jamais modifiée : déclencheur de la base) et porte les fenêtres de mesure.
 * AWAITING_VERIFICATION : baseline figée, action pas encore vérifiée · OBSERVING : fenêtre d'observation fixée · MEASURED : résultat rendu · CANCELLED : action annulée avant mesure.
 */
export const experiments = pgTable("experiments", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  actionId: text("action_id").notNull().references(() => revenueActions.id, { onDelete: "cascade" }),
  opportunityId: text("opportunity_id").notNull(),
  status: text("status").notNull().default("AWAITING_VERIFICATION"),
  /** Jour d'entrée en vigueur : date déclarée (procédure manuelle) ou jour de l'exécution. */
  effectiveOn: date("effective_on", { mode: "string" }).notNull(),
  /** Séjours visés, ramenés aux nuits encore à vendre à l'entrée en vigueur (null = toutes déjà passées). */
  stayFrom: date("stay_from", { mode: "string" }),
  stayTo: date("stay_to", { mode: "string" }),
  baselineFrom: date("baseline_from", { mode: "string" }).notNull(),
  baselineTo: date("baseline_to", { mode: "string" }).notNull(),
  /** Fixée à la vérification de l'action ; null avant. */
  observeFrom: date("observe_from", { mode: "string" }),
  observeTo: date("observe_to", { mode: "string" }),
  /** Baseline figée (voir `experiments/baseline.ts`). Immuable. */
  baseline: jsonb("baseline").$type<any>().notNull(),
  capturedAt: ts("captured_at").notNull().defaultNow(),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("experiments_action").on(t.actionId), index("experiments_tenant").on(t.tenantId, t.status), index("experiments_property").on(t.tenantId, t.propertyId, t.createdAt)]);

/**
 * US-111 : la mesure finale d'une expérience (blueprint §12.1 « Experiment 1─* Measurement »). Une seule mesure finale par expérience.
 * Immuable (déclencheur de la base : aucune modification) : un résultat rendu ne se réécrit pas. `legacy` : mesure des actions refermées avant l'épic 11,
 * sans référence figée (résultat repris tel quel, jamais recalculé).
 * outcome : POSITIVE · NEUTRAL · NEGATIVE · INCONCLUSIVE.
 */
export const experimentMeasurements = pgTable("experiment_measurements", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  experimentId: text("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
  actionId: text("action_id").notNull().references(() => revenueActions.id, { onDelete: "cascade" }),
  outcome: text("outcome").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  observeFrom: date("observe_from", { mode: "string" }),
  observeTo: date("observe_to", { mode: "string" }),
  /** Chiffres comparés (attendu, observé, net par nuit…) : voir `experiments/outcome.ts`. */
  metrics: jsonb("metrics").$type<any>().notNull(),
  summary: text("summary").notNull(),
  interpretation: text("interpretation").notNull(),
  confidence: text("confidence").notNull().default("faible"),
  legacy: boolean("legacy").notNull().default(false),
  measuredAt: ts("measured_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("experiment_measurements_experiment").on(t.experimentId), index("experiment_measurements_tenant").on(t.tenantId, t.measuredAt), index("experiment_measurements_property").on(t.tenantId, t.propertyId, t.measuredAt)]);

/**
 * Rapport mensuel certifié (US-112, blueprint §6.5). Un rapport = un instantané des métriques du mois + un texte.
 * Brouillon : le texte se retouche, l'instantané se régénère. Certifié : plus rien ne se modifie (déclencheur en base) ; corriger = ouvrir une nouvelle version.
 * status : DRAFT · CERTIFIED. `certified_hash` : empreinte de l'instantané et du texte au moment de la certification.
 */
export const monthlyReports = pgTable("monthly_reports", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  month: text("month").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("DRAFT"),
  snapshot: jsonb("snapshot").$type<any>().notNull(),
  narrative: text("narrative").notNull(),
  edited: boolean("edited").notNull().default(false),
  createdBy: text("created_by").notNull(),
  certifiedBy: text("certified_by"),
  certifiedByName: text("certified_by_name"),
  certifiedHash: text("certified_hash"),
  certifiedAt: ts("certified_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("monthly_reports_version").on(t.tenantId, t.propertyId, t.month, t.version),
  uniqueIndex("monthly_reports_one_draft").on(t.tenantId, t.propertyId, t.month).where(sql`${t.status} = 'DRAFT'`),
  index("monthly_reports_tenant").on(t.tenantId, t.month),
]);


/** Routeur LLM : registre des modèles (disponibilité, cycle de vie, tailles). Global : le comportement d'un modèle ne dépend pas du propriétaire. */
export const llmModels = pgTable("llm_models", {
  /** Identifiant API figé du modèle (jamais un alias mouvant « -latest ») */
  modelId: text("model_id").primaryKey(),
  /** anthropic | openai | mistral */
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  /** eco | intermediaire | premium */
  tier: text("tier").notNull(),
  /** Clé de ce modèle dans le fichier de prix LiteLLM (table de correspondance du catalogue) */
  priceKey: text("price_key"),
  /** UNKNOWN (jamais listé) | ACTIVE | DEPRECATED | RETIRED | ABSENT (le fournisseur ne le liste plus) */
  lifecycle: text("lifecycle").notNull().default("UNKNOWN"),
  deprecatedAt: ts("deprecated_at"),
  retiresAt: ts("retires_at"),
  maxInputTokens: integer("max_input_tokens"),
  maxOutputTokens: integer("max_output_tokens"),
  /** JSON structuré pris en charge : null = inconnu */
  supportsJson: boolean("supports_json"),
  /** Alias mouvant : jamais routé */
  isAlias: boolean("is_alias").notNull().default(false),
  lastSeenAt: ts("last_seen_at"),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Routeur LLM : instantanés de prix par modèle (USD par million de jetons). Le prix en vigueur est le dernier VALIDATED ; un changement détecté reste PENDING jusqu'à validation. */
export const llmPriceSnapshots = pgTable("llm_price_snapshots", {
  id: id(),
  /** Ordre d'insertion strictement croissant : départage deux instantanés de même horodatage (le dernier validé est toujours le plus récent) */
  seq: bigserial("seq", { mode: "number" }).notNull(),
  modelId: text("model_id").notNull().references(() => llmModels.modelId, { onDelete: "cascade" }),
  inputUsdPerMtok: numeric("input_usd_per_mtok", { precision: 14, scale: 6 }).notNull(),
  outputUsdPerMtok: numeric("output_usd_per_mtok", { precision: 14, scale: 6 }).notNull(),
  /** Palier « long prompt » : au-delà de ce nombre de jetons d'entrée, toute la requête est facturée au prix long */
  longThresholdTokens: integer("long_threshold_tokens"),
  longInputUsdPerMtok: numeric("long_input_usd_per_mtok", { precision: 14, scale: 6 }),
  longOutputUsdPerMtok: numeric("long_output_usd_per_mtok", { precision: 14, scale: 6 }),
  /** LITELLM | OVERRIDE (variable LLM_PRICE_OVERRIDES) */
  source: text("source").notNull(),
  /** VALIDATED | PENDING | REJECTED */
  status: text("status").notNull(),
  observedAt: ts("observed_at").notNull().defaultNow(),
  validatedAt: ts("validated_at"),
  /** Compte ayant validé (identifiant utilisateur) ; « system » pour une première observation ou une surcharge */
  validatedBy: text("validated_by"),
}, (t) => [
  index("llm_prices_model").on(t.modelId, t.status, t.observedAt),
  // un seul changement de prix en attente par modèle
  uniqueIndex("llm_prices_one_pending").on(t.modelId).where(sql`${t.status} = 'PENDING'`),
]);

/** Routeur LLM : journal des synchronisations (prix, disponibilité) : sert à la fréquence du job et à l'écran des modèles. */
export const llmSyncRuns = pgTable("llm_sync_runs", {
  id: id(),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  ok: boolean("ok").notNull().default(false),
  /** Compteurs et erreurs par étape (prix, disponibilité) */
  stats: jsonb("stats").$type<any>().notNull().default({}),
}, (t) => [index("llm_sync_started").on(t.startedAt)]);
