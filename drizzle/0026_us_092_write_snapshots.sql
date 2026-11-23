-- US-092 : instantanés avant/après d'une écriture PriceLabs, avec empreintes. Idempotent (rejouable sans effet).
ALTER TABLE "external_writes" ADD COLUMN IF NOT EXISTS "state_before" jsonb;--> statement-breakpoint
ALTER TABLE "external_writes" ADD COLUMN IF NOT EXISTS "state_after" jsonb;--> statement-breakpoint
ALTER TABLE "external_writes" ADD COLUMN IF NOT EXISTS "state_before_hash" text;--> statement-breakpoint
ALTER TABLE "external_writes" ADD COLUMN IF NOT EXISTS "state_after_hash" text;
