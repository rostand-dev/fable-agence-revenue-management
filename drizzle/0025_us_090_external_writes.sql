-- US-090 : journal des écritures vers PriceLabs (idempotence, reçu). Idempotent.
CREATE TABLE IF NOT EXISTS "external_writes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"action_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"phase" text NOT NULL,
	"provider" text DEFAULT 'pricelabs' NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"plan" jsonb NOT NULL,
	"receipt" jsonb,
	"error" text,
	"adapter" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_writes_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "external_writes" ADD CONSTRAINT "external_writes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "external_writes" ADD CONSTRAINT "external_writes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "external_writes" ADD CONSTRAINT "external_writes_action_id_revenue_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."revenue_actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_writes_action" ON "external_writes" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_writes_tenant" ON "external_writes" USING btree ("tenant_id","created_at");--> statement-breakpoint
-- Isolation par la base (US-011) ; le rôle applicatif lit, ajoute et met à jour (statut, reçu) mais ne supprime jamais une ligne : même schéma que 0016 à 0018, avec UPDATE en plus.
-- Rejouable : RLS déjà active sans effet, politique supprimée puis recréée, droits retirés puis accordés de nouveau.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "external_writes" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "external_writes";
	CREATE POLICY tenant_isolation ON "external_writes" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "external_writes" FROM nuitsignal_app;
	GRANT SELECT, INSERT, UPDATE ON "external_writes" TO nuitsignal_app;
END $$;
