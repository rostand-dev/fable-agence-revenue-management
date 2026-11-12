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
  createdAt: created(),
});

export const properties = pgTable("properties", {
  id: id(),
  tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
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
  createdAt: created(),
}, (t) => [index("properties_tenant").on(t.tenantId)]);

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
}, (t) => [uniqueIndex("reservations_ext").on(t.propertyId, t.externalId), index("reservations_prop").on(t.tenantId, t.propertyId, t.checkIn)]);

export const calendarDays = pgTable("calendar_days", {
  propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  tenantId: text("tenant_id").notNull(),
  /** Prix publié par PriceLabs, centimes. null = inconnu */
  priceCents: integer("price_cents"),
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
}, (t) => [index("audit_tenant").on(t.tenantId, t.createdAt)]);

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
