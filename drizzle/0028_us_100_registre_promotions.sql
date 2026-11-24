-- US-100 : registre des promotions (annonce visée, fenêtre de réservation, durée minimale, audience, référence externe, fin et auteur). Idempotent (rejouable sans effet). L'isolation par propriétaire de la table existe déjà (0011).
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "listing_id" text;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "book_from" date;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "book_to" date;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "min_los" integer;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "audience" text DEFAULT 'ALL' NOT NULL;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "external_ref" text;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "created_by" text;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "verified_by" text;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "end_reason" text;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Audience des lignes existantes (démonstration, promotions déclarées par une action) : déduite du type, comme le fait le registre. Rejouable : ne touche que les lignes encore à « ALL ».
UPDATE "promotions" SET "audience" = CASE "kind" WHEN 'GENIUS' THEN 'MEMBERS' WHEN 'MOBILE' THEN 'MOBILE' WHEN 'COUNTRY' THEN 'COUNTRY' END WHERE "audience" = 'ALL' AND "kind" IN ('GENIUS', 'MOBILE', 'COUNTRY');
