CREATE TABLE IF NOT EXISTS "feature_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"flag" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feature_flags_key" ON "feature_flags" USING btree ("tenant_id","flag","scope","scope_id");