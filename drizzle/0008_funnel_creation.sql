-- Idempotente : rejouable sans erreur si une version antérieure a déjà été appliquée (preview).
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "onboarding" jsonb;
