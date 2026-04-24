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

# Connect as the bootstrap superuser (POSTGRES_USER / POSTGRES_DB). psql's
# ON_ERROR_STOP aborts the whole container start if any statement fails,
# so a half-initialised volume can't hide behind a "healthy" postgres.
# --set binds variables server-side so identifiers / literals are quoted
# safely (no shell interpolation into SQL).
psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set "keycloak_db=$KEYCLOAK_DB_NAME" \
  --set "keycloak_user=$KEYCLOAK_DB_USER" \
  --set "keycloak_password=$KEYCLOAK_DB_PASSWORD" <<'EOSQL'
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'keycloak_user', :'keycloak_password') AS stmt
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'keycloak_user')
\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'keycloak_db', :'keycloak_user') AS stmt
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'keycloak_db')
\gexec

-- Least-privilege: revoke default PUBLIC connect, grant only the Keycloak role.
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'keycloak_db') \gexec
SELECT format('GRANT ALL PRIVILEGES ON DATABASE %I TO %I', :'keycloak_db', :'keycloak_user') \gexec
EOSQL

echo "Keycloak database '${KEYCLOAK_DB_NAME}' and role '${KEYCLOAK_DB_USER}' provisioned."
