CREATE TABLE IF NOT EXISTS "market_gap_history" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"day" date NOT NULL,
	"window_key" text NOT NULL,
	"gap" real,
	"occupancy" real,
	"market_occupancy" real,
	"avg_percentile" real,
	"free_nights" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "market_gap_history" ADD CONSTRAINT "market_gap_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "market_gap_history" ADD CONSTRAINT "market_gap_history_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "market_gap_history_day" ON "market_gap_history" USING btree ("property_id","day","window_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "market_gap_history_tenant" ON "market_gap_history" USING btree ("tenant_id","property_id","day");--> statement-breakpoint
-- Isolation par la base (US-011). Le rôle applicatif lit, ajoute, remplace (la dernière revue du jour fait foi) et purge l'historique ancien. Rejouable.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "market_gap_history" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "market_gap_history";
	CREATE POLICY tenant_isolation ON "market_gap_history" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "market_gap_history" FROM nuitsignal_app;
	GRANT SELECT, INSERT, UPDATE, DELETE ON "market_gap_history" TO nuitsignal_app;
END $$;
