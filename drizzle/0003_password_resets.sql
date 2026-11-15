CREATE TABLE "auth_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_resets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_attempts_lookup" ON "auth_attempts" USING btree ("kind","key_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "password_resets_token" ON "password_resets" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_resets_user" ON "password_resets" USING btree ("user_id");