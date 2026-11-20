-- US-011 : isolation par propriétaire côté base (Row Level Security), en complément des filtres tenant_id de l'application.
-- Rôle « nuitsignal_app » : sans connexion propre, endossé par SET LOCAL ROLE (voir src/db/tenant.ts). Les politiques ne
-- s'appliquent qu'à lui : l'application qui se connecte avec son propriétaire de base n'est pas modifiée tant que TENANT_RLS n'est pas activé.
-- Rejouable : rôle créé seulement s'il manque, politiques supprimées puis recréées, droits accordés de nouveau sans effet de bord.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN
		CREATE ROLE nuitsignal_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
	END IF;
EXCEPTION WHEN insufficient_privilege THEN
	RAISE NOTICE 'nuitsignal_app non créé : privilège CREATEROLE manquant ; l''isolation par la base reste inactive (voir /api/health).';
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN
		-- le propriétaire doit pouvoir endosser le rôle (inutile pour un superutilisateur, requis sinon)
		BEGIN EXECUTE format('GRANT nuitsignal_app TO %I', current_user); EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'GRANT nuitsignal_app TO % impossible (%) : /api/health signalera l''isolation indisponible.', current_user, SQLERRM; END;
	END IF;
END $$;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nuitsignal_app') THEN RETURN; END IF;
	EXECUTE format('GRANT USAGE ON SCHEMA %I TO nuitsignal_app', current_schema());
	FOREACH t IN ARRAY ARRAY['users','properties','reservations','calendar_days','market_days','promotions','opportunities','revenue_actions','agent_runs','audit_events','integrations','feature_flags','llm_credentials','review_runs','chat_messages'] LOOP
		EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
		EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
		EXECUTE format('CREATE POLICY tenant_isolation ON %I TO nuitsignal_app USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', t);
		EXECUTE format('REVOKE ALL ON %I FROM nuitsignal_app', t);
		IF t = 'users' THEN
			-- aucune écriture de compte ne passe par le rôle restreint : lecture seule (moindre privilège)
			EXECUTE format('GRANT SELECT ON %I TO nuitsignal_app', t);
		ELSIF t = 'audit_events' THEN
			-- journal en ajout seul : le rôle applicatif ne peut que lire et ajouter
			EXECUTE format('GRANT SELECT, INSERT ON %I TO nuitsignal_app', t);
		ELSE
			EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nuitsignal_app', t);
		END IF;
	END LOOP;
	-- le propriétaire : il ne voit que son propre enregistrement
	ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
	DROP POLICY IF EXISTS tenant_isolation ON tenants;
	CREATE POLICY tenant_isolation ON tenants TO nuitsignal_app USING (id = current_setting('app.tenant_id', true)) WITH CHECK (id = current_setting('app.tenant_id', true));
	REVOKE ALL ON tenants FROM nuitsignal_app;
	GRANT SELECT, UPDATE ON tenants TO nuitsignal_app;
END $$;
