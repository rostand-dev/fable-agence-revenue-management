ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "action_id" text;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "effective_on" date;--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "proof" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotions_action_id_uniq" ON "promotions" USING btree ("action_id") WHERE action_id is not null;