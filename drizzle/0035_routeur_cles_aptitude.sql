CREATE TABLE IF NOT EXISTS "llm_qualifications" (
	"model_id" text NOT NULL,
	"task" text NOT NULL,
	"status" text NOT NULL,
	"bench_score" numeric(5, 4),
	"bench_cases" integer,
	"reason" text,
	"details" jsonb,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evaluated_by" text,
	CONSTRAINT "llm_qualifications_model_id_task_pk" PRIMARY KEY("model_id","task")
);
--> statement-breakpoint
-- Clé primaire (tenant_id) → (tenant_id, provider) : idempotent (rejouable sans effet une fois migrée)
DO $$
DECLARE pk_name text;
BEGIN
	SELECT c.conname INTO pk_name FROM pg_constraint c
	WHERE c.conrelid = 'public.llm_credentials'::regclass AND c.contype = 'p' AND array_length(c.conkey, 1) = 1;
	IF pk_name IS NOT NULL THEN
		EXECUTE format('ALTER TABLE "llm_credentials" DROP CONSTRAINT %I', pk_name);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.llm_credentials'::regclass AND c.contype = 'p') THEN
		ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_tenant_id_provider_pk" PRIMARY KEY ("tenant_id", "provider");
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "llm_qualifications" ADD CONSTRAINT "llm_qualifications_model_id_llm_models_model_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."llm_models"("model_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;