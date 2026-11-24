CREATE TABLE IF NOT EXISTS "experiment_measurements" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"action_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observe_from" date,
	"observe_to" date,
	"metrics" jsonb NOT NULL,
	"summary" text NOT NULL,
	"interpretation" text NOT NULL,
	"confidence" text DEFAULT 'faible' NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "experiment_measurements" ADD CONSTRAINT "experiment_measurements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "experiment_measurements" ADD CONSTRAINT "experiment_measurements_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "experiment_measurements" ADD CONSTRAINT "experiment_measurements_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "experiment_measurements" ADD CONSTRAINT "experiment_measurements_action_id_revenue_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."revenue_actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experiment_measurements_experiment" ON "experiment_measurements" USING btree ("experiment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_measurements_tenant" ON "experiment_measurements" USING btree ("tenant_id","measured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiment_measurements_property" ON "experiment_measurements" USING btree ("tenant_id","property_id","measured_at");--> statement-breakpoint
-- Un résultat rendu ne se réécrit pas : aucune modification d'une mesure (la suppression n'a lieu que par cascade avec le logement ou l'action). Rejouable.
CREATE OR REPLACE FUNCTION ns_measurement_freeze() RETURNS trigger AS $fn$
BEGIN
	RAISE EXCEPTION 'Une mesure est figée : un résultat rendu ne se modifie pas.' USING ERRCODE = 'check_violation';
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS ns_measurement_freeze ON "experiment_measurements";--> statement-breakpoint
CREATE TRIGGER ns_measurement_freeze BEFORE UPDATE ON "experiment_measurements" FOR EACH ROW EXECUTE FUNCTION ns_measurement_freeze();--> statement-breakpoint
-- Lecture tolérante d'une date déclarée : NULL plutôt qu'une migration qui plante. Fonction temporaire, rejouable.
CREATE OR REPLACE FUNCTION pg_temp.ns_safe_date(t text) RETURNS date AS $f$
BEGIN
	IF t IS NULL OR t !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN NULL; END IF;
	RETURN t::date;
EXCEPTION WHEN others THEN RETURN NULL;
END;
$f$ LANGUAGE plpgsql;--> statement-breakpoint
-- Actions refermées avant l'épic 11 : expérience « héritée » (sans référence figée) et mesure reprise telle quelle, jamais recalculée. Rejouable (une seule expérience par action, une seule mesure par expérience).
INSERT INTO "experiments" ("id", "tenant_id", "property_id", "action_id", "opportunity_id", "status", "effective_on", "stay_from", "stay_to", "baseline_from", "baseline_to", "observe_from", "observe_to", "baseline")
SELECT 'exp_' || replace(gen_random_uuid()::text, '-', ''), a."tenant_id", a."property_id", a."id", a."opportunity_id", 'MEASURED',
	eff.d, o."stay_from", o."stay_to", eff.d, eff.d, NULL, NULL,
	jsonb_build_object('version', 0, 'legacy', true, 'sufficient', false, 'limits', jsonb_build_array('LEGACY'), 'onBooks', a."execution" -> 'baseline')
FROM "revenue_actions" a
JOIN "opportunities" o ON o."id" = a."opportunity_id"
CROSS JOIN LATERAL (SELECT COALESCE(pg_temp.ns_safe_date(a."execution" ->> 'declaredDate'), (COALESCE(a."executed_at", a."created_at") AT TIME ZONE 'Europe/Paris')::date) AS d) eff
WHERE a."status" = 'CLOSED' AND NOT EXISTS (SELECT 1 FROM "experiments" e WHERE e."action_id" = a."id");--> statement-breakpoint
INSERT INTO "experiment_measurements" ("id", "tenant_id", "property_id", "experiment_id", "action_id", "outcome", "reasons", "metrics", "summary", "interpretation", "confidence", "legacy", "measured_at")
SELECT 'mes_' || replace(gen_random_uuid()::text, '-', ''), e."tenant_id", e."property_id", e."id", a."id",
	CASE WHEN a."measurement" ->> 'outcome' IN ('POSITIVE', 'NEUTRAL', 'NEGATIVE') THEN a."measurement" ->> 'outcome' ELSE 'INCONCLUSIVE' END,
	jsonb_build_array('LEGACY'), jsonb_build_object('legacy', true),
	COALESCE(NULLIF(a."measurement" ->> 'observed', ''), 'Mesure antérieure au suivi des expériences.'),
	COALESCE(NULLIF(a."measurement" ->> 'interpretation', ''), 'Résultat repris tel quel : aucune référence n''avait été figée.'),
	COALESCE(NULLIF(a."measurement" ->> 'confidence', ''), 'faible'), true,
	COALESCE(CASE WHEN (a."measurement" ->> 'measuredAt') ~ '^\d{4}-\d{2}-\d{2}' THEN (a."measurement" ->> 'measuredAt')::timestamptz END, a."updated_at")
FROM "experiments" e
JOIN "revenue_actions" a ON a."id" = e."action_id"
WHERE a."status" = 'CLOSED' AND a."measurement" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "experiment_measurements" m WHERE m."experiment_id" = e."id");--> statement-breakpoint
-- Les expériences héritées dont l'action est refermée sont mesurées (rejouable).
UPDATE "experiments" e SET "status" = 'MEASURED' FROM "revenue_actions" a WHERE a."id" = e."action_id" AND a."status" = 'CLOSED' AND e."status" IN ('AWAITING_VERIFICATION', 'OBSERVING');--> statement-breakpoint
-- Isolation par la base (US-011). Le rôle applicatif lit et ajoute (jamais de modification ni de suppression). Rejouable.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "experiment_measurements" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "experiment_measurements";
	CREATE POLICY tenant_isolation ON "experiment_measurements" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "experiment_measurements" FROM nuitsignal_app;
	GRANT SELECT, INSERT ON "experiment_measurements" TO nuitsignal_app;
END $$;
