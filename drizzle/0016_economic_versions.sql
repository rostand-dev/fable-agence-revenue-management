CREATE TABLE IF NOT EXISTS "economic_model_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"version" integer NOT NULL,
	"model" jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "economics_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "economic_model_versions" ADD CONSTRAINT "economic_model_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "economic_model_versions" ADD CONSTRAINT "economic_model_versions_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "economic_versions_property_version" ON "economic_model_versions" USING btree ("property_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "economic_versions_tenant" ON "economic_model_versions" USING btree ("tenant_id");--> statement-breakpoint
-- Isolation par la base (US-011) : même politique que les autres tables à tenant_id (voir 0011). Les versions sont immuables pour l'application :
-- le rôle applicatif n'a que SELECT et INSERT (les suppressions en cascade d'un logement ou d'un espace passent par les clés étrangères, pas par ses droits).
-- Rejouable : RLS déjà active sans effet, politique supprimée puis recréée, droits retirés puis accordés de nouveau.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "economic_model_versions" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "economic_model_versions";
	CREATE POLICY tenant_isolation ON "economic_model_versions" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "economic_model_versions" FROM nuitsignal_app;
	GRANT SELECT, INSERT ON "economic_model_versions" TO nuitsignal_app;
END $$;--> statement-breakpoint
-- Reprise : chaque logement réel déjà lancé (hors création en cours) qui a déjà un modèle économique reçoit une version 1 (auteur « system »), sans détail de changements.
-- Rejouable : seuls les logements sans version sont repris.
INSERT INTO "economic_model_versions" ("id", "tenant_id", "property_id", "version", "model", "changes", "created_by")
SELECT 'ecv_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 20), p."tenant_id", p."id", 1, p."economics" - 'answers', '[]'::jsonb, 'system'
FROM "properties" p
WHERE NOT p."is_demo" AND p."status" <> 'ONBOARDING' AND p."economics" IS NOT NULL AND p."economics" <> '{}'::jsonb AND (p."economics"->'channels') <> '{}'::jsonb
  AND NOT EXISTS (SELECT 1 FROM "economic_model_versions" v WHERE v."property_id" = p."id");--> statement-breakpoint
UPDATE "properties" p SET "economics_version" = 1
WHERE "economics_version" = 0 AND EXISTS (SELECT 1 FROM "economic_model_versions" v WHERE v."property_id" = p."id");
