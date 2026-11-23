-- US-094 : alertes d'exécution PriceLabs et date de la dernière relecture de dérive. Idempotent (rejouable sans effet).
CREATE TABLE IF NOT EXISTS "execution_alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text,
	"action_id" text,
	"write_id" text,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"notified_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "revenue_actions" ADD COLUMN IF NOT EXISTS "drift_checked_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "execution_alerts" ADD CONSTRAINT "execution_alerts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "execution_alerts" ADD CONSTRAINT "execution_alerts_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "execution_alerts" ADD CONSTRAINT "execution_alerts_action_id_revenue_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."revenue_actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_alerts_tenant" ON "execution_alerts" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_alerts_action" ON "execution_alerts" USING btree ("action_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_alerts_open_dedupe" ON "execution_alerts" USING btree ("tenant_id","dedupe_key") WHERE status <> 'RESOLVED';--> statement-breakpoint
-- Isolation par la base (US-011) ; le rôle applicatif lit, ajoute et met à jour (statut) mais ne supprime jamais une ligne : même schéma que 0025.
-- Rejouable : RLS déjà active sans effet, politique supprimée puis recréée, droits retirés puis accordés de nouveau.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "execution_alerts" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "execution_alerts";
	CREATE POLICY tenant_isolation ON "execution_alerts" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "execution_alerts" FROM nuitsignal_app;
	GRANT SELECT, INSERT, UPDATE ON "execution_alerts" TO nuitsignal_app;
END $$;
