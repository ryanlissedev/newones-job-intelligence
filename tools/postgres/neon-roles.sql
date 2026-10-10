-- Neon role split (RJC-381, ADR-0004 role model, ADR-0006 operational readiness).
--
-- Creates the three least-privilege roles ADR-0004 required, on Neon, where
-- everything currently runs as the project owner role (`neondb_owner`).
-- Idempotent: safe to re-run. Mirrors the pattern already used for the local/CI
-- Docker lane in tools/postgres/init/10-bootstrap-roles.sh, generalised from
-- the single `public` schema there to this project's app schemas
-- (`public` for Better Auth tables, `curated`, `staging`, `marts`) plus
-- `drizzle` for the migration journal that `/readyz` probes as `ji_app` (CTP-465).
--
-- Usage (operator, against Neon):
--   psql "$NEON_OWNER_DATABASE_URL" \
--     --set ON_ERROR_STOP=1 \
--     --set migrator_password="$(op read ...)" \
--     --set app_password="$(op read ...)" \
--     --set readonly_password="$(op read ...)" \
--     -f tools/postgres/neon-roles.sql
--
-- Never hardcode passwords here or pass them on the command line where they
-- would appear in shell history — use psql -v/--set with a value read
-- straight from a secret manager into a variable, never echoed.
--
-- This script is NOT wired into `bun run db:migrate` on purpose: role/grant
-- management is an instance-level operational action taken once by an
-- operator with the Neon owner connection string, not a versioned schema
-- migration replayed by every environment (test/CI never need these roles).

\set ON_ERROR_STOP on

-- 1. Roles (idempotent create; password set unconditionally so re-running
--    with a rotated password updates it).
SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'ji_migrator'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ji_migrator')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'ji_app'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ji_app')
\gexec

SELECT format(
  'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  'ji_readonly'
)
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ji_readonly')
\gexec

ALTER ROLE ji_migrator PASSWORD :'migrator_password';
ALTER ROLE ji_app PASSWORD :'app_password';
ALTER ROLE ji_readonly PASSWORD :'readonly_password';

-- 2. Database-level connect. Neon's owner role owns the database, so this
--    grant runs as that owner (matches the local bootstrap's REVOKE ALL /
--    GRANT CONNECT pattern, but does not revoke the owner's own access).
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'ji_migrator')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'ji_app')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), 'ji_readonly')
\gexec

-- 3. Schema-level privileges, per schema this project actually uses.
--    ji_migrator gets CREATE (it runs `drizzle-kit migrate`, which adds
--    tables/indexes over time). ji_app and ji_readonly only get USAGE.
DO $$
DECLARE
  schema_name text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['public', 'curated', 'staging', 'marts']
  LOOP
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO ji_migrator', schema_name);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO ji_app', schema_name);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO ji_readonly', schema_name);

    -- Existing objects: migrations already applied on Neon predate this
    -- script, so grants must cover current tables/sequences, not only ones
    -- created after this runs.
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO ji_app',
      schema_name
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO ji_app',
      schema_name
    );
    EXECUTE format(
      'GRANT SELECT ON ALL TABLES IN SCHEMA %I TO ji_readonly',
      schema_name
    );

    -- Future objects: only meaningful once migrations start running as
    -- ji_migrator (see runbook mapping table) rather than neondb_owner.
    -- Harmless no-op grant for objects the owner still creates until then.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE ji_migrator IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ji_app',
      schema_name
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE ji_migrator IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO ji_app',
      schema_name
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE ji_migrator IN SCHEMA %I GRANT SELECT ON TABLES TO ji_readonly',
      schema_name
    );
  END LOOP;
END $$;

-- 3b. Drizzle migration journal (CTP-465).
--    `/readyz` runs as `ji_app` and SELECTs `drizzle.__drizzle_migrations`.
--    The schema is normally created by `drizzle-kit migrate` as `ji_migrator`,
--    but new DBs must not regress if roles are bootstrapped before/after the
--    first migrate: ensure the schema exists, grant USAGE + SELECT for the
--    probe, and default-privilege SELECT for future journal tables.
--    Matches the live on-box grants (ji_app USAGE on schema + SELECT on the
--    journal table; ji_readonly intentionally has no drizzle access).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle') THEN
    EXECUTE 'CREATE SCHEMA drizzle AUTHORIZATION ji_migrator';
  END IF;

  EXECUTE 'GRANT USAGE, CREATE ON SCHEMA drizzle TO ji_migrator';
  EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO ji_app';
  EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ji_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE ji_migrator IN SCHEMA drizzle GRANT SELECT ON TABLES TO ji_app';
END $$;

-- 4. Verification query (also documented in docs/runbooks/neon-restore.md).
--    Confirms the three roles exist, are LOGIN, and are not superusers.
SELECT
  rolname,
  rolcanlogin AS can_login,
  rolsuper AS is_superuser,
  rolcreaterole AS can_create_role,
  rolcreatedb AS can_create_db
FROM pg_roles
WHERE rolname IN ('ji_migrator', 'ji_app', 'ji_readonly')
ORDER BY rolname;
