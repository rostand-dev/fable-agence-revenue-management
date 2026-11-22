-- US-065 : historique des transitions d'état d'une action et garde-fou en base. Idempotent.
CREATE TABLE IF NOT EXISTS "action_transitions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"action_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "action_transitions" ADD CONSTRAINT "action_transitions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "action_transitions" ADD CONSTRAINT "action_transitions_action_id_revenue_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."revenue_actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_transitions_action" ON "action_transitions" USING btree ("action_id","created_at");--> statement-breakpoint
-- une action ne naît qu'à l'état DRAFT et ne change d'état que selon le graphe du blueprint §6.6 (miroir de src/lib/engine/stateMachine.ts, verrouillé par un test)
CREATE OR REPLACE FUNCTION ns_action_check_transition() RETURNS trigger AS $fn$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF NEW.status <> 'DRAFT' THEN
			RAISE EXCEPTION 'Transition interdite : une action naît à l''état DRAFT (reçu %)', NEW.status USING ERRCODE = 'check_violation';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
		RETURN NEW;
	END IF;
	IF NOT (
		(OLD.status = 'DRAFT' AND NEW.status IN ('SIMULATED', 'CANCELLED')) OR
		(OLD.status = 'SIMULATED' AND NEW.status IN ('AUDITED', 'CANCELLED')) OR
		(OLD.status = 'AUDITED' AND NEW.status IN ('PENDING_APPROVAL', 'REJECTED', 'CANCELLED')) OR
		(OLD.status = 'PENDING_APPROVAL' AND NEW.status IN ('APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')) OR
		(OLD.status = 'APPROVED' AND NEW.status IN ('EXECUTING', 'CANCELLED', 'EXPIRED')) OR
		(OLD.status = 'EXECUTING' AND NEW.status IN ('EXECUTED', 'FAILED')) OR
		(OLD.status = 'EXECUTED' AND NEW.status IN ('VERIFIED', 'FAILED', 'ROLLED_BACK')) OR
		(OLD.status = 'VERIFIED' AND NEW.status IN ('MEASURING', 'ROLLED_BACK')) OR
		(OLD.status = 'MEASURING' AND NEW.status IN ('CLOSED', 'ROLLED_BACK')) OR
		(OLD.status = 'FAILED' AND NEW.status = 'ROLLED_BACK')
	) THEN
		RAISE EXCEPTION 'Transition interdite : % → %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION ns_action_log_transition() RETURNS trigger AS $fn$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO action_transitions (id, tenant_id, action_id, from_status, to_status)
		VALUES ('trn_' || replace(gen_random_uuid()::text, '-', ''), NEW.tenant_id, NEW.id, NULL, NEW.status);
	ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
		INSERT INTO action_transitions (id, tenant_id, action_id, from_status, to_status)
		VALUES ('trn_' || replace(gen_random_uuid()::text, '-', ''), NEW.tenant_id, NEW.id, OLD.status, NEW.status);
	END IF;
	RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS ns_action_check_transition ON "revenue_actions";--> statement-breakpoint
CREATE TRIGGER ns_action_check_transition BEFORE INSERT OR UPDATE OF status ON "revenue_actions" FOR EACH ROW EXECUTE FUNCTION ns_action_check_transition();--> statement-breakpoint
DROP TRIGGER IF EXISTS ns_action_log_transition ON "revenue_actions";--> statement-breakpoint
CREATE TRIGGER ns_action_log_transition AFTER INSERT OR UPDATE OF status ON "revenue_actions" FOR EACH ROW EXECUTE FUNCTION ns_action_log_transition();--> statement-breakpoint
-- actions antérieures à la migration : leur état courant est le premier point de leur historique
INSERT INTO "action_transitions" ("id", "tenant_id", "action_id", "from_status", "to_status", "created_at")
SELECT 'trn_' || replace(gen_random_uuid()::text, '-', ''), a."tenant_id", a."id", NULL, a."status", a."updated_at"
FROM "revenue_actions" a
WHERE NOT EXISTS (SELECT 1 FROM "action_transitions" t WHERE t."action_id" = a."id");
--> statement-breakpoint
-- Isolation par la base (US-011). L'historique est en ajout seul pour l'application (SELECT et INSERT, par le déclencheur). Rejouable.
DO $$
DECLARE t text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	FOREACH t IN ARRAY ARRAY['action_transitions'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format('CREATE POLICY tenant_isolation ON %I TO nuitsignal_app USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
		EXECUTE format('REVOKE ALL ON %I FROM nuitsignal_app', t);
		EXECUTE format('GRANT SELECT, INSERT ON %I TO nuitsignal_app', t);
	END LOOP;
END $$;
