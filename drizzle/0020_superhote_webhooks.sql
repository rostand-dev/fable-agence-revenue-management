CREATE TABLE IF NOT EXISTS "superhote_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"token_fingerprint" text NOT NULL,
	"remote_id" text NOT NULL,
	"secret_enc" text NOT NULL,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_received_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"endpoint_id" text,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"property_id" text,
	"external_id" text,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"outcome" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claimed_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "superhote_webhooks" ADD CONSTRAINT "superhote_webhooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_superhote_webhooks_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."superhote_webhooks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "superhote_webhooks_token" ON "superhote_webhooks" USING btree ("tenant_id","token_fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "superhote_webhooks_tenant" ON "superhote_webhooks" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_unique" ON "webhook_deliveries" USING btree ("endpoint_id","delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status" ON "webhook_deliveries" USING btree ("tenant_id","status","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_tenant" ON "webhook_deliveries" USING btree ("tenant_id");--> statement-breakpoint
-- Isolation par la base (US-011). Les points de réception : lecture, ajout, modification, suppression. La boîte de réception : lecture, ajout et changement d'état
-- (pas de suppression : la purge fera l'objet d'une règle de rétention explicite). Rejouable : RLS déjà active sans effet, politiques recréées, droits retirés puis accordés de nouveau.
DO $$
DECLARE t text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	FOREACH t IN ARRAY ARRAY['superhote_webhooks','webhook_deliveries'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format('CREATE POLICY tenant_isolation ON %I TO nuitsignal_app USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
		EXECUTE format('REVOKE ALL ON %I FROM nuitsignal_app', t);
		IF t = 'webhook_deliveries' THEN EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO nuitsignal_app', t);
		ELSE EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nuitsignal_app', t); END IF;
	END LOOP;
END $$;
