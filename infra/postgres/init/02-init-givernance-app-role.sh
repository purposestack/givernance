#!/usr/bin/env bash
# Provision the application role `givernance_app` on first Postgres bring-up.
#
# Background (issue #430): the application + worker connect to Postgres as
# `givernance_app` (NOBYPASSRLS) so the `users.tenant_isolation` RLS policy
# is enforced at the connection level. The owner role `givernance` (BYPASSRLS)
# stays on DATABASE_URL for migrations and legitimate cross-tenant work.
#
# Migration 0005_rls_app_role.sql also creates `givernance_app` with a
# committed dev password ('givernance_app_dev'). That's fine for local +
# CI, but on staging/prod we override here with the GH-env secret so the
# password never sits in git history.
#
# Postgres image semantics: scripts in /docker-entrypoint-initdb.d run
# exactly once, on a brand-new datadir. So this fires on `docker compose
# up -d` against an empty pgdata and never again. The EXISTING staging
# cluster pre-dates this script; rotation on the running cluster goes
# through `docs/runbooks/givernance-app-password-rotation.md`.

set -euo pipefail

: "${GIVERNANCE_APP_PASSWORD:?GIVERNANCE_APP_PASSWORD must be set on the postgres service (issue #430)}"

# Role attributes are made explicit (NOSUPERUSER NOCREATEDB NOCREATEROLE
# NOREPLICATION NOBYPASSRLS INHERIT) so the least-privilege posture is
# audit-visible. The `CREATE ROLE` from migration 0005 will already have
# run by the time `drizzle-kit migrate` connects — but on a fresh datadir
# the init scripts run first, before any migration. The `WHERE NOT EXISTS`
# idempotency guard makes the script harmless if the role was already
# created by a prior pass.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set "app_password=$GIVERNANCE_APP_PASSWORD" <<'EOSQL'
SELECT format(
  'CREATE ROLE givernance_app WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
  :'app_password'
) AS stmt
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'givernance_app')
\gexec

-- Always rotate the password from the secret (idempotent on subsequent
-- fresh-inits with the same secret; safe on the very first init where
-- the CREATE ROLE above already set it).
SELECT format('ALTER ROLE givernance_app WITH PASSWORD %L', :'app_password') \gexec

-- Belt-and-suspenders: even if a prior CREATE ROLE inadvertently set
-- BYPASSRLS, this makes the posture explicit. The boot-time guard in
-- `assertAppRoleSecure` / `assertWorkerAppRoleSecure` reads
-- `pg_roles.rolbypassrls` and crashes the process on misconfig.
ALTER ROLE givernance_app NOBYPASSRLS;
EOSQL

echo "Application role 'givernance_app' provisioned + password rotated (issue #430)."
