CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"opportunity_id" text,
	"operation" text NOT NULL,
	"mode" text NOT NULL,
	"model" text,
	"prompt_version" text,
	"summary" text NOT NULL,
	"output" jsonb,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"actor" text NOT NULL,
	"type" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_days" (
	"property_id" text NOT NULL,
	"date" date NOT NULL,
	"tenant_id" text NOT NULL,
	"price_cents" integer,
	"min_stay" integer,
	"state" text NOT NULL,
	"rule" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_days_property_id_date_pk" PRIMARY KEY("property_id","date")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"opportunity_id" text,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "market_days" (
	"property_id" text NOT NULL,
	"date" date NOT NULL,
	"tenant_id" text NOT NULL,
	"market_occupancy" real,
	"market_adr_cents" integer,
	"price_percentile" integer,
	"event" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_days_property_id_date_pk" PRIMARY KEY("property_id","date")
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"code" text NOT NULL,
	"playbook" text NOT NULL,
	"reason_code" text NOT NULL,
	"title" text NOT NULL,
	"stay_from" date NOT NULL,
	"stay_to" date NOT NULL,
	"dedupe_key" text NOT NULL,
	"signals" jsonb NOT NULL,
	"diagnosis" jsonb NOT NULL,
	"candidates" jsonb NOT NULL,
	"selected" integer DEFAULT 0 NOT NULL,
	"priority" real DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"risk" text DEFAULT 'LOW' NOT NULL,
	"impact_cents" integer,
	"veto" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"decision" text,
	"defer_until" date,
	"narrative" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"discount_pct" real NOT NULL,
	"stay_from" date,
	"stay_to" date,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"kind" text NOT NULL,
	"bedrooms" integer,
	"capacity" integer,
	"status" text DEFAULT 'ONBOARDING' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"economics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"strategy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"strategy_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"external_id" text NOT NULL,
	"channel" text NOT NULL,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"nights" integer NOT NULL,
	"gross_room_cents" integer NOT NULL,
	"cleaning_cents" integer,
	"commission_cents" integer,
	"payment_fee_cents" integer,
	"status" text DEFAULT 'CONFIRMED' NOT NULL,
	"booked_at" date NOT NULL,
	"source" text DEFAULT 'DEMO' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"type" text NOT NULL,
	"label" text NOT NULL,
	"target" jsonb NOT NULL,
	"parameters" jsonb NOT NULL,
	"simulation" jsonb NOT NULL,
	"audit" jsonb NOT NULL,
	"status" text NOT NULL,
	"risk_level" text NOT NULL,
	"rollback_plan" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"approval_comment" text,
	"approved_by_id" text,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"execution" jsonb,
	"verified_at" timestamp with time zone,
	"measure_due_at" date,
	"measurement" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_actions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "review_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text DEFAULT 'DAILY' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'OWNER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "calendar_days" ADD CONSTRAINT "calendar_days_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_days" ADD CONSTRAINT "market_days_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_actions" ADD CONSTRAINT "revenue_actions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_actions" ADD CONSTRAINT "revenue_actions_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_agent" ON "agent_runs" USING btree ("tenant_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_opp" ON "agent_runs" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "audit_tenant" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_agent" ON "chat_messages" USING btree ("tenant_id","agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_provider" ON "integrations" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "opps_code" ON "opportunities" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "opps_status" ON "opportunities" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "opps_dedupe" ON "opportunities" USING btree ("tenant_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "promotions_prop" ON "promotions" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "properties_tenant" ON "properties" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_ext" ON "reservations" USING btree ("property_id","external_id");--> statement-breakpoint
CREATE INDEX "reservations_prop" ON "reservations" USING btree ("tenant_id","property_id","check_in");--> statement-breakpoint
CREATE INDEX "actions_status" ON "revenue_actions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "reviews_tenant" ON "review_runs" USING btree ("tenant_id","started_at");