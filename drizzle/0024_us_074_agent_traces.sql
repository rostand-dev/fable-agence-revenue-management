-- US-074 : trace des appels de modèle (fournisseur, prompt versionné, correction, cause du repli). Idempotent.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "provider" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "prompt_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "prompt_hash" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "attempts" integer;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "repaired" boolean;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "fallback_reason" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "trace" jsonb;