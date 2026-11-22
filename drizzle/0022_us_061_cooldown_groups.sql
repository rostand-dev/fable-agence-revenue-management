-- US-061 : date de décision (période de repos par playbook) et clé de regroupement des dossiers. Idempotent.
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "group_key" text;--> statement-breakpoint
-- les dossiers déjà tranchés n'ont pas de date de décision : à défaut, la date d'ouverture (comportement précédent du repos)
UPDATE "opportunities" SET "decided_at" = "created_at" WHERE "status" = 'DECIDED' AND "decided_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opps_group" ON "opportunities" USING btree ("tenant_id","property_id","group_key");
