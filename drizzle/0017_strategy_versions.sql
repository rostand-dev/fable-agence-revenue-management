CREATE TABLE IF NOT EXISTS "strategy_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"version" integer NOT NULL,
	"strategy" jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"created_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "strategy_draft" jsonb;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_versions_property_version" ON "strategy_versions" USING btree ("property_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "strategy_versions_tenant" ON "strategy_versions" USING btree ("tenant_id");--> statement-breakpoint
-- Isolation par la base (US-011) et ajout seul pour le rôle applicatif (SELECT et INSERT) : même schéma que 0016.
-- Rejouable : RLS déjà active sans effet, politique supprimée puis recréée, droits retirés puis accordés de nouveau.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "strategy_versions" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "strategy_versions";
	CREATE POLICY tenant_isolation ON "strategy_versions" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "strategy_versions" FROM nuitsignal_app;
	GRANT SELECT, INSERT ON "strategy_versions" TO nuitsignal_app;
END $$;--> statement-breakpoint
-- Reprise : chaque logement réel déjà lancé reçoit une version de départ au numéro de sa stratégie actuelle (auteur « system », sans détail).
-- Rejouable : seuls les logements sans version sont repris.
INSERT INTO "strategy_versions" ("id", "tenant_id", "property_id", "version", "strategy", "changes", "source", "created_by")
SELECT 'stv_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20), p."tenant_id", p."id", p."strategy_version", p."strategy", '[]'::jsonb, 'SYSTEM', 'system'
FROM "properties" p
WHERE NOT p."is_demo" AND p."status" <> 'ONBOARDING' AND p."strategy_version" >= 1
  AND NOT EXISTS (SELECT 1 FROM "strategy_versions" v WHERE v."property_id" = p."id");
