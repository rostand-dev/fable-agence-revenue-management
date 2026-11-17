ALTER TABLE "calendar_days" ADD COLUMN IF NOT EXISTS "recommended_price_cents" integer;--> statement-breakpoint
ALTER TABLE "calendar_days" ADD COLUMN IF NOT EXISTS "sent_price_cents" integer;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "channel_markups" jsonb DEFAULT '[]'::jsonb NOT NULL;