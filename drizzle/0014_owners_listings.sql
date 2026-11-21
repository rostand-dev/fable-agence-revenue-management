CREATE TABLE IF NOT EXISTS "listings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text,
	"url" text,
	"title" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "owners" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"notes" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "owner_id" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "listings" ADD CONSTRAINT "listings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "listings" ADD CONSTRAINT "listings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "owners" ADD CONSTRAINT "owners_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "listings_property" ON "listings" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "listings_channel_external" ON "listings" USING btree ("tenant_id","channel","external_id") WHERE external_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "listings_one_active_per_channel" ON "listings" USING btree ("property_id","channel") WHERE status = 'ACTIVE' and channel in ('AIRBNB', 'BOOKING');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "owners_tenant" ON "owners" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "owners_one_default" ON "owners" USING btree ("tenant_id") WHERE is_default;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "owners_name_ci" ON "owners" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "properties" ADD CONSTRAINT "properties_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Isolation par la base (US-011) pour les deux nouvelles tables : même politique que les autres tables à tenant_id (voir 0011).
-- Rejouable : RLS déjà active sans effet, politique supprimée puis recréée, droits accordés de nouveau sans effet de bord.
DO $$
DECLARE t text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	FOREACH t IN ARRAY ARRAY['owners','listings'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format('CREATE POLICY tenant_isolation ON %I TO nuitsignal_app USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
		EXECUTE format('REVOKE ALL ON %I FROM nuitsignal_app', t);
		EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nuitsignal_app', t);
	END LOOP;
END $$;--> statement-breakpoint
-- Reprise des espaces existants : un propriétaire « par défaut » (nommé comme l'espace) et tous les logements qui n'en ont pas lui sont rattachés.
-- Rejouable : n'ajoute un propriétaire que s'il n'y a pas déjà de propriétaire par défaut, ne rattache que les logements encore sans propriétaire.
INSERT INTO "owners" ("id", "tenant_id", "name", "is_default")
SELECT 'own_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20), t."id", t."name", true
FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "owners" o WHERE o."tenant_id" = t."id" AND o."is_default");--> statement-breakpoint
UPDATE "properties" p SET "owner_id" = o."id"
FROM "owners" o
WHERE o."tenant_id" = p."tenant_id" AND o."is_default" AND p."owner_id" IS NULL;
