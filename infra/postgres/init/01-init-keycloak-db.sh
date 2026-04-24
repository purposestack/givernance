#!/usr/bin/env bash
# Create the Keycloak logical database + owner role on first Postgres bring-up.
#
# The postgres image runs every executable in /docker-entrypoint-initdb.d
# exactly once, when the data directory is empty. So this fires on
# `docker compose up -d` against a fresh `pgdata` volume and never again.
#
# Rationale: Keycloak must NOT share the `public` schema of the application
# database. See docs/15-infra-adr.md (ADR-017) and docs/infra/README.md.

set -euo pipefail

: "${KEYCLOAK_DB_NAME:?KEYCLOAK_DB_NAME must be set on the postgres service}"
: "${KEYCLOAK_DB_USER:?KEYCLOAK_DB_USER must be set on the postgres service}"
: "${KEYCLOAK_DB_PASSWORD:?KEYCLOAK_DB_PASSWORD must be set on the postgres service}"

# Phase 1 — create the role + database (connected to the bootstrap DB).
#
# psql's ON_ERROR_STOP aborts the whole container start if any statement fails,
# so a half-initialised volume can't hide behind a "healthy" postgres.
# --set binds variables server-side so identifiers / literals are quoted
# safely (no shell interpolation into SQL).
#
# The `WHERE NOT EXISTS` idempotency guards are load-bearing only for a
# `pg_upgrade`-style restore into a non-empty volume (the normal path never
# re-enters this script). Keeping them means a manual re-run of the init
# directory won't error on the second pass.
#
# Role attributes are made explicit (NOSUPERUSER NOCREATEDB NOCREATEROLE
# NOREPLICATION NOBYPASSRLS INHERIT) to match the precedent set by
# `givernance_app` in docs/02-reference-architecture.md §6 and to make the
# least-privilege posture audit-visible rather than implicit.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set "keycloak_db=$KEYCLOAK_DB_NAME" \
  --set "keycloak_user=$KEYCLOAK_DB_USER" \
  --set "keycloak_password=$KEYCLOAK_DB_PASSWORD" <<'EOSQL'
SELECT format(
  'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
  :'keycloak_user', :'keycloak_password'
) AS stmt
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'keycloak_user')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'keycloak_db', :'keycloak_user') AS stmt
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'keycloak_db')
\gexec

-- Least-privilege on the database itself: revoke the default PUBLIC connect.
-- The `keycloak` role already has full privileges via OWNER, so no explicit
-- DATABASE grant is needed (it would be a no-op).
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'keycloak_db') \gexec
EOSQL

# Phase 2 — harden the auto-created `public` schema inside the new DB.
#
# Postgres 16 creates a `public` schema on every new database and grants
# CREATE/USAGE to the PUBLIC pseudo-role by default. Revoking at the DATABASE
# level above does NOT remove those schema-level grants, so any future role
# added to the cluster would inherit CREATE on Keycloak's `public`. Lock it
# down to `keycloak` only.
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$KEYCLOAK_DB_NAME" \
  --set "keycloak_user=$KEYCLOAK_DB_USER" <<'EOSQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT ALL ON SCHEMA public TO %I', :'keycloak_user') \gexec
EOSQL

echo "Keycloak database '${KEYCLOAK_DB_NAME}' and role '${KEYCLOAK_DB_USER}' provisioned."
