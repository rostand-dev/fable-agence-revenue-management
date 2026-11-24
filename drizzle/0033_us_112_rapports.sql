CREATE TABLE IF NOT EXISTS "monthly_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"month" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"narrative" text NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"certified_by" text,
	"certified_by_name" text,
	"certified_hash" text,
	"certified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_reports_version" ON "monthly_reports" USING btree ("tenant_id","property_id","month","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monthly_reports_one_draft" ON "monthly_reports" USING btree ("tenant_id","property_id","month") WHERE "monthly_reports"."status" = 'DRAFT';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monthly_reports_tenant" ON "monthly_reports" USING btree ("tenant_id","month");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_status_check" CHECK ("status" IN ('DRAFT', 'CERTIFIED'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_month_check" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "monthly_reports" ADD CONSTRAINT "monthly_reports_certified_check" CHECK ("status" = 'DRAFT' OR ("certified_by" IS NOT NULL AND "certified_at" IS NOT NULL AND "certified_hash" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Un rapport certifié ne se modifie plus ; l'identité d'un rapport (espace, logement, mois, version) ne change jamais. Corriger = ouvrir une nouvelle version. Rejouable.
CREATE OR REPLACE FUNCTION ns_report_freeze() RETURNS trigger AS $fn$
BEGIN
	IF OLD.status = 'CERTIFIED' THEN
		RAISE EXCEPTION 'Un rapport certifié est figé : ouvrez une nouvelle version pour le corriger.' USING ERRCODE = 'check_violation';
	END IF;
	IF NEW.tenant_id <> OLD.tenant_id OR NEW.property_id <> OLD.property_id OR NEW.month <> OLD.month OR NEW.version <> OLD.version THEN
		RAISE EXCEPTION 'Le logement, le mois et la version d''un rapport ne changent pas.' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS ns_report_freeze ON "monthly_reports";--> statement-breakpoint
CREATE TRIGGER ns_report_freeze BEFORE UPDATE ON "monthly_reports" FOR EACH ROW EXECUTE FUNCTION ns_report_freeze();--> statement-breakpoint
-- Isolation par la base (US-011). Le rôle applicatif lit, ajoute et modifie (le déclencheur fige les rapports certifiés) ; jamais de suppression. Rejouable.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "monthly_reports" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "monthly_reports";
	CREATE POLICY tenant_isolation ON "monthly_reports" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "monthly_reports" FROM nuitsignal_app;
	GRANT SELECT, INSERT, UPDATE ON "monthly_reports" TO nuitsignal_app;
END $$;
--> statement-breakpoint
-- Un rapport certifié ne se supprime pas directement (même en superutilisateur applicatif) ; il part seulement avec son logement ou son espace (suppression en cascade). Rejouable.
CREATE OR REPLACE FUNCTION ns_report_no_delete() RETURNS trigger AS $fn$
BEGIN
	IF OLD.status = 'CERTIFIED' AND pg_trigger_depth() < 2 THEN
		RAISE EXCEPTION 'Un rapport certifié ne se supprime pas : ouvrez une nouvelle version pour le corriger.' USING ERRCODE = 'check_violation';
	END IF;
	RETURN OLD;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS ns_report_no_delete ON "monthly_reports";--> statement-breakpoint
CREATE TRIGGER ns_report_no_delete BEFORE DELETE ON "monthly_reports" FOR EACH ROW EXECUTE FUNCTION ns_report_no_delete();
