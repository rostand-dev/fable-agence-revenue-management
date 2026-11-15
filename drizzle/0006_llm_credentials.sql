CREATE TABLE "llm_credentials" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'anthropic' NOT NULL,
	"api_key_enc" text NOT NULL,
	"key_hint" text NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"models_fetched_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;