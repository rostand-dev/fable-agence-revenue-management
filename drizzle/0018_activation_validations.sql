CREATE TABLE IF NOT EXISTS "activation_validations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"kind" text NOT NULL,
	"fingerprint" text,
	"payload" jsonb NOT NULL,
	"validated_by" text NOT NULL,
	"validated_by_name" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "activation_validations" ADD CONSTRAINT "activation_validations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "activation_validations" ADD CONSTRAINT "activation_validations_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activation_validations_property_kind" ON "activation_validations" USING btree ("property_id","kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activation_validations_tenant" ON "activation_validations" USING btree ("tenant_id");--> statement-breakpoint
-- Isolation par la base (US-011) et ajout seul pour le rôle applicatif (SELECT et INSERT) : même schéma que 0016 et 0017.
-- Rejouable : RLS déjà active sans effet, politique supprimée puis recréée, droits retirés puis accordés de nouveau.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "activation_validations" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "activation_validations";
	CREATE POLICY tenant_isolation ON "activation_validations" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "activation_validations" FROM nuitsignal_app;
	GRANT SELECT, INSERT ON "activation_validations" TO nuitsignal_app;
END $$;
