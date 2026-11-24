CREATE TABLE IF NOT EXISTS "llm_models" (
	"model_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"tier" text NOT NULL,
	"price_key" text,
	"lifecycle" text DEFAULT 'UNKNOWN' NOT NULL,
	"deprecated_at" timestamp with time zone,
	"retires_at" timestamp with time zone,
	"max_input_tokens" integer,
	"max_output_tokens" integer,
	"supports_json" boolean,
	"is_alias" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_price_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"model_id" text NOT NULL,
	"input_usd_per_mtok" numeric(14, 6) NOT NULL,
	"output_usd_per_mtok" numeric(14, 6) NOT NULL,
	"long_threshold_tokens" integer,
	"long_input_usd_per_mtok" numeric(14, 6),
	"long_output_usd_per_mtok" numeric(14, 6),
	"source" text NOT NULL,
	"status" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	"validated_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean DEFAULT false NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "cost_usd" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "cost_estimated_usd" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "price_snapshot_id" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "llm_price_snapshots" ADD CONSTRAINT "llm_price_snapshots_model_id_llm_models_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."llm_models"("model_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_prices_model" ON "llm_price_snapshots" USING btree ("model_id","status","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_prices_one_pending" ON "llm_price_snapshots" USING btree ("model_id") WHERE "llm_price_snapshots"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_sync_started" ON "llm_sync_runs" USING btree ("started_at");