-- US-102 : étapes cochées du guide pas-à-pas d'une action manuelle. Idempotent (rejouable sans effet).
CREATE TABLE IF NOT EXISTS "runbook_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"action_id" text NOT NULL,
	"step_id" text NOT NULL,
	"done_by" text NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runbook_steps" ADD CONSTRAINT "runbook_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runbook_steps" ADD CONSTRAINT "runbook_steps_action_id_revenue_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."revenue_actions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runbook_steps_unique" ON "runbook_steps" USING btree ("action_id","step_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runbook_steps_tenant" ON "runbook_steps" USING btree ("tenant_id","action_id");--> statement-breakpoint
-- Isolation par la base (US-011) ; le rôle applicatif lit, ajoute et supprime (décocher une étape) : même schéma que 0027, sans mise à jour.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	ALTER TABLE "runbook_steps" ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON "runbook_steps";
	CREATE POLICY tenant_isolation ON "runbook_steps" TO nuitsignal_app USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
	REVOKE ALL ON "runbook_steps" FROM nuitsignal_app;
	GRANT SELECT, INSERT, DELETE ON "runbook_steps" TO nuitsignal_app;
END $$;
