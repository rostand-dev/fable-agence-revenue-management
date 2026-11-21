CREATE TABLE IF NOT EXISTS "source_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"adapter" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"content_hash" text NOT NULL,
	"unchanged_of" text,
	"payload" jsonb,
	"quality_score" integer NOT NULL,
	"lineage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "source_snapshots" ADD CONSTRAINT "source_snapshots_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
ALTER TABLE "calendar_days" ADD COLUMN IF NOT EXISTS "snapshot_id" text;--> statement-breakpoint
ALTER TABLE "market_days" ADD COLUMN IF NOT EXISTS "snapshot_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_snapshots_latest" ON "source_snapshots" USING btree ("property_id","kind","observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_snapshots_tenant" ON "source_snapshots" USING btree ("tenant_id");--> statement-breakpoint
-- Immuabilité garantie aussi pour le propriétaire de la table (pas seulement pour le rôle applicatif) : toute modification ou suppression directe est refusée.
-- La suppression en cascade d'un logement ou d'un locataire passe (profondeur de déclencheur > 1).
CREATE OR REPLACE FUNCTION source_snapshots_immutable() RETURNS trigger AS $f$
BEGIN
	IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
	RAISE EXCEPTION 'source_snapshots est en ajout seul : % refusé', TG_OP USING ERRCODE = 'restrict_violation';
END
$f$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "source_snapshots_immutable" ON "source_snapshots";--> statement-breakpoint
CREATE TRIGGER "source_snapshots_immutable" BEFORE UPDATE OR DELETE ON "source_snapshots" FOR EACH ROW EXECUTE FUNCTION source_snapshots_immutable();--> statement-breakpoint
-- Isolation par la base (US-011). Les snapshots sont en ajout seul (SELECT et INSERT) : jamais modifiés ni supprimés par l'application (blueprint §12.4).
-- Rejouable : RLS déjà active sans effet, politique recréée, droits retirés puis accordés de nouveau.
DO $$
DECLARE t text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	FOREACH t IN ARRAY ARRAY['source_snapshots'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format('CREATE POLICY tenant_isolation ON %I TO nuitsignal_app USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
		EXECUTE format('REVOKE ALL ON %I FROM nuitsignal_app', t);
		EXECUTE format('GRANT SELECT, INSERT ON %I TO nuitsignal_app', t);
	END LOOP;
END $$;
