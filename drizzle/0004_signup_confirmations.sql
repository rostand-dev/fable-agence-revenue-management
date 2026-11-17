CREATE TABLE IF NOT EXISTS "signup_confirmations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signup_confirmations_token" ON "signup_confirmations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_confirmations_email" ON "signup_confirmations" USING btree ("email");