CREATE TABLE IF NOT EXISTS "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"action_id" text NOT NULL,
	"opportunity_id" text NOT NULL,
	"status" text DEFAULT 'AWAITING_VERIFICATION' NOT NULL,
	"effective_on" date NOT NULL,
	"stay_from" date,
	"stay_to" date,
	"baseline_from" date NOT NULL,
	"baseline_to" date NOT NULL,
	"observe_from" date,
	"observe_to" date,
	"baseline" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "experiments" ADD CONSTRAINT "experiments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "experiments" ADD CONSTRAINT "experiments_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "experiments" ADD CONSTRAINT "experiments_action_id_revenue_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."revenue_actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "experiments_action" ON "experiments" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_tenant" ON "experiments" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_property" ON "experiments" USING btree ("tenant_id","property_id","created_at");--> statement-breakpoint
-- La baseline est figée à la capture : ni elle, ni les fenêtres de référence et de séjours, ni la date d'entrée en vigueur ne se modifient (blueprint §12.4 : les snapshots sont immuables). Rejouable.
CREATE OR REPLACE FUNCTION ns_experiment_freeze() RETURNS trigger AS $fn$
BEGIN
	IF NEW.baseline IS DISTINCT FROM OLD.baseline OR NEW.effective_on IS DISTINCT FROM OLD.effective_on
		OR NEW.baseline_from IS DISTINCT FROM OLD.baseline_from OR NEW.baseline_to IS DISTINCT FROM OLD.baseline_to
		OR NEW.stay_from IS DISTINCT FROM OLD.stay_from OR NEW.stay_to IS DISTINCT FROM OLD.stay_to
		OR NEW.action_id IS DISTINCT FROM OLD.action_id OR NEW.captured_at IS DISTINCT FROM OLD.captured_at THEN
		RAISE EXCEPTION 'La baseline d''une expérience est figée : elle ne se modifie pas.' USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS ns_experiment_freeze ON "experiments";--> statement-breakpoint
CREATE TRIGGER ns_experiment_freeze BEFORE UPDATE ON "experiments" FOR EACH ROW EXECUTE FUNCTION ns_experiment_freeze();--> statement-breakpoint
-- Actions déjà exécutées et pas encore mesurées au moment de la migration : une expérience « héritée » (version 0), sans fenêtre de référence ni rythme.
-- Leur mesure sera non concluante : une baseline qui n'a pas été figée ne s'invente pas après coup. Rejouable (une seule expérience par action).
INSERT INTO "experiments" ("id", "tenant_id", "property_id", "action_id", "opportunity_id", "status", "effective_on", "stay_from", "stay_to", "baseline_from", "baseline_to", "observe_from", "observe_to", "baseline")
SELECT 'exp_' || replace(gen_random_uuid()::text, '-', ''), a."tenant_id", a."property_id", a."id", a."opportunity_id",
	CASE WHEN a."status" = 'EXECUTED' THEN 'AWAITING_VERIFICATION' ELSE 'OBSERVING' END,
	eff.d, o."stay_from", o."stay_to", eff.d, eff.d,
	CASE WHEN a."status" = 'EXECUTED' THEN NULL ELSE eff.d END,
	CASE WHEN a."status" = 'EXECUTED' THEN NULL ELSE a."measure_due_at" END,
	jsonb_build_object('version', 0, 'legacy', true, 'sufficient', false, 'limits', jsonb_build_array('LEGACY'), 'onBooks', a."execution" -> 'baseline')
FROM "revenue_actions" a
JOIN "opportunities" o ON o."id" = a."opportunity_id"
CROSS JOIN LATERAL (SELECT CASE WHEN (a."execution" ->> 'declaredDate') ~ '^\d{4}-\d{2}-\d{2}$' THEN (a."execution" ->> 'declaredDate')::date ELSE (COALESCE(a."executed_at", a."created_at") AT TIME ZONE 'Europe/Paris')::date END AS d) eff
WHERE a."status" IN ('EXECUTED', 'VERIFIED', 'MEASURING')
	AND NOT EXISTS (SELECT 1 FROM "experiments" e WHERE e."action_id" = a."id");--> statement-breakpoint
-- Isolation par la base (US-011). Le rôle applicatif lit, ajoute et met à jour l'état (jamais de suppression : l'historique des mesures se garde). Rejouable.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "experiments" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "experiments";
	CREATE POLICY tenant_isolation ON "experiments" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "experiments" FROM nuitsignal_app;
	GRANT SELECT, INSERT, UPDATE ON "experiments" TO nuitsignal_app;
END $$;
