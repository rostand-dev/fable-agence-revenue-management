-- US-012 : le journal d'audit est en ajout seul. La règle est portée par la base, pas par le code :
-- aucune modification, aucune suppression, aucune troncature, quel que soit le rôle ou le code qui s'y essaie.
-- Idempotente : rejouable sans erreur si une version antérieure a déjà été appliquée (preview).
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_events est en ajout seul : % refusé', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_no_change ON "audit_events";
--> statement-breakpoint
CREATE TRIGGER audit_events_no_change BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_no_truncate ON "audit_events";
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
-- Lecture d'une chronologie par objet (dossier, action, logement) : « tout ce qui est arrivé à cet objet ».
CREATE INDEX IF NOT EXISTS "audit_entity" ON "audit_events" USING btree ("tenant_id","entity","entity_id","created_at");
