import type { OnboardingState } from "@/lib/onboarding";
import { sql } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp, jsonb, date, real, primaryKey, index, uniqueIndex } from "drizzle-orm/pg-core";

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
}, (t) => [primaryKey({ columns: [t.propertyId, t.date] })]);

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
}, (t) => [index("promotions_prop").on(t.tenantId, t.propertyId)]);

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
  narrative: jsonb("narrative").$type<any>(),
  createdAt: created(),
  expiresAt: date("expires_at", { mode: "string" }).notNull(),
}, (t) => [uniqueIndex("opps_code").on(t.tenantId, t.code), index("opps_status").on(t.tenantId, t.status), index("opps_dedupe").on(t.tenantId, t.dedupeKey)]);

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
  execution: jsonb("execution").$type<any>(),
  verifiedAt: ts("verified_at"),
  measureDueAt: date("measure_due_at", { mode: "string" }),
  measurement: jsonb("measurement").$type<any>(),
  createdAt: created(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [index("actions_status").on(t.tenantId, t.status)]);

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
  summary: text("summary").notNull(),
  output: jsonb("output").$type<any>(),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  durationMs: integer("duration_ms").notNull().default(0),
  error: text("error"),
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
