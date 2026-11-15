ALTER TABLE "calendar_days" ADD COLUMN "recommended_price_cents" integer;--> statement-breakpoint
ALTER TABLE "calendar_days" ADD COLUMN "sent_price_cents" integer;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "channel_markups" jsonb DEFAULT '[]'::jsonb NOT NULL;