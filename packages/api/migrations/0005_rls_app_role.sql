-- Migration: 0005_rls_app_role
-- Implements the Postgres 3-Role Pattern for RLS tenant isolation:
--   1. givernance       (owner) — runs migrations, owns tables, BYPASSES RLS
--   2. givernance_app   (app)   — used by the API, subject to RLS policies
--   3. (future) givernance_readonly — analytics / read-only access
--
-- The API connects as givernance_app and sets app.current_org_id via
-- set_config() inside each transaction (withTenantContext).
-- Workers and the outbox relay continue to connect as givernance (owner)
-- so they legitimately bypass RLS for cross-tenant operations.

-- Create the API role (NOBYPASSRLS — subject to RLS policies)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'givernance_app') THEN
    CREATE ROLE givernance_app WITH LOGIN PASSWORD 'givernance_app_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

-- Grant permissions to the app role
GRANT USAGE ON SCHEMA public TO givernance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO givernance_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO givernance_app;
