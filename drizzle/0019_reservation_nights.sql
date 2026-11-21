CREATE TABLE IF NOT EXISTS "reservation_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"delivery_id" text,
	"occurred_at" timestamp with time zone,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reservation_nights" (
	"reservation_id" text NOT NULL,
	"night" date NOT NULL,
	"tenant_id" text NOT NULL,
	"property_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"gross_room_cents" integer NOT NULL,
	"commission_cents" integer,
	"payment_fee_cents" integer,
	CONSTRAINT "reservation_nights_reservation_id_night_pk" PRIMARY KEY("reservation_id","night")
);
--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "source_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reservation_changes" ADD CONSTRAINT "reservation_changes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reservation_changes" ADD CONSTRAINT "reservation_changes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reservation_nights" ADD CONSTRAINT "reservation_nights_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reservation_nights" ADD CONSTRAINT "reservation_nights_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservation_changes_property" ON "reservation_changes" USING btree ("property_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservation_changes_resa" ON "reservation_changes" USING btree ("property_id","external_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservation_changes_tenant" ON "reservation_changes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservation_nights_property_night" ON "reservation_nights" USING btree ("property_id","night");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reservation_nights_tenant" ON "reservation_nights" USING btree ("tenant_id");--> statement-breakpoint
-- Isolation par la base (US-011). Les nuits suivent leur réservation (lecture, ajout, modification, suppression) ; l'historique est en ajout seul
-- (SELECT et INSERT), comme les versions du modèle économique et de la stratégie. Rejouable : RLS déjà active sans effet, politiques recréées, droits retirés puis accordés de nouveau.
DO $$
DECLARE t text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	FOREACH t IN ARRAY ARRAY['reservation_nights','reservation_changes'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format('CREATE POLICY tenant_isolation ON %I TO nuitsignal_app USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
		EXECUTE format('REVOKE ALL ON %I FROM nuitsignal_app', t);
		IF t = 'reservation_changes' THEN EXECUTE format('GRANT SELECT, INSERT ON %I TO nuitsignal_app', t);
		ELSE EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nuitsignal_app', t); END IF;
	END LOOP;
END $$;--> statement-breakpoint
-- Reprise : les réservations déjà enregistrées reçoivent leurs nuits (CONFIRMED et BLOCKED seulement, 1 à 400 nuits).
-- Même règle d'allocation que src/lib/reservations/nights.ts : montant ÷ nuits, le reste d'un centime par nuit sur les premières nuits.
-- Rejouable : une nuit déjà présente est conservée (clé primaire).
INSERT INTO "reservation_nights" ("reservation_id", "night", "tenant_id", "property_id", "channel", "status", "gross_room_cents", "commission_cents", "payment_fee_cents")
SELECT r."id", (r."check_in" + g.i)::date, r."tenant_id", r."property_id", r."channel", r."status",
	r."gross_room_cents" / d.n + CASE WHEN g.i < abs(r."gross_room_cents" % d.n) THEN sign(r."gross_room_cents" % d.n)::int ELSE 0 END,
	CASE WHEN r."commission_cents" IS NULL THEN NULL ELSE r."commission_cents" / d.n + CASE WHEN g.i < abs(r."commission_cents" % d.n) THEN sign(r."commission_cents" % d.n)::int ELSE 0 END END,
	CASE WHEN r."payment_fee_cents" IS NULL THEN NULL ELSE r."payment_fee_cents" / d.n + CASE WHEN g.i < abs(r."payment_fee_cents" % d.n) THEN sign(r."payment_fee_cents" % d.n)::int ELSE 0 END END
FROM "reservations" r
CROSS JOIN LATERAL (SELECT (r."check_out" - r."check_in") AS n) d
CROSS JOIN LATERAL generate_series(0, LEAST(d.n, 400) - 1) AS g(i)
WHERE r."status" IN ('CONFIRMED', 'BLOCKED') AND d.n BETWEEN 1 AND 400
ON CONFLICT DO NOTHING;
