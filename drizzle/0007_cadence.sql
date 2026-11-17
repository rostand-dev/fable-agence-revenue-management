-- Idempotente : rejouable sans erreur si une version antérieure a déjà été appliquée (preview).
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "cadence" jsonb;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "next_reservations_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "next_prices_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "next_review_at" timestamp with time zone;