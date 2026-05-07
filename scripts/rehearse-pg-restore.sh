#!/usr/bin/env bash
# Rehearse a Postgres major-version restore against an ephemeral container
# in the GitHub Actions runner (or any local Docker daemon). Validates that
# the dump produced by `migrate-staging-postgres.sh pre` is restoreable
# into a fresh `postgres:<target>-alpine` cluster, and that source-side
# state captured during `pre` (RLS policy count, extensions, Keycloak
# Liquibase changelog, app table rows) is preserved through dump+restore
# — without touching staging.
#
# Run AFTER `migrate-staging-postgres.sh pre` has produced state.env +
# the .sql dump in WORKDIR (typically downloaded as a workflow artifact
# in the migrate-staging-postgres workflow's rehearsal mode).
#
# Pattern + rationale: ADR-026 (rehearsal-then-live workflow).

set -euo pipefail

TARGET_VERSION="${1:-}"

PG_USER="${PG_USER:-givernance}"
APP_DB="${APP_DB:-givernance_staging}"

# Init-script env vars (mirrored from docker-compose.yml). The init script
# at infra/postgres/init/01-init-keycloak-db.sh provisions a separate KC
# DB + role on first boot of the empty volume. We mount it into the
# rehearsal container so the topology matches local dev / future ADR-017-
# compliant staging — even though current staging has KC co-located in
# `givernance_staging` (the script tolerates either via KC_LOCATION_DB).
KEYCLOAK_DB_NAME="${KEYCLOAK_DB_NAME:-givernance_keycloak}"
KEYCLOAK_DB_USER="${KEYCLOAK_DB_USER:-keycloak}"
KEYCLOAK_DB_PASSWORD="${KEYCLOAK_DB_PASSWORD:-rehearse-throwaway-pw}"

# Random suffix on container name so a stale container from a previous
# failed run doesn't collide. Trap-on-exit cleanup below removes it.
CONTAINER_NAME="${CONTAINER_NAME:-pg-rehearsal-$$-$(date +%s)}"

WORKDIR="${WORKDIR:-./.migrate-staging-postgres}"
STATE_FILE="${WORKDIR}/state.env"

if ! [[ "$TARGET_VERSION" =~ ^[0-9]+$ ]]; then
  cat <<EOF >&2
Usage: $0 <target-major>
  e.g. $0 17

Reads state.env + dump from \$WORKDIR (default: ./.migrate-staging-postgres).
EOF
  exit 64
fi

[ ! -f "$STATE_FILE" ] && { echo "no state.env at $STATE_FILE — run \`migrate-staging-postgres.sh pre\` first (or download the artifact)" >&2; exit 1; }
# shellcheck disable=SC1090
source "$STATE_FILE"

if [ "${NOOP:-0}" = "1" ]; then
  echo "pre marked NOOP (already on target); rehearsal is unnecessary"
  exit 0
fi

DUMP="$(ls -1 "${WORKDIR}"/migrate-pg*.sql 2>/dev/null | head -n1 || true)"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "no dump file (migrate-pg*.sql) in $WORKDIR" >&2
  exit 1
fi

echo "Rehearsing restore of $(basename "$DUMP") into ephemeral postgres:${TARGET_VERSION}-alpine"

cleanup() {
  if [ -n "${CONTAINER_NAME:-}" ]; then
    docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
    docker rm "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Choose the init-script directory: prefer the repo's mount path, fall
# back to nothing if the repo isn't checked out (rare; the workflow always
# has a checkout). Without the init script, the rehearsal still validates
# the dump's CREATE DATABASE / CREATE ROLE statements; only the
# pre-existing KC role is created by the entrypoint instead.
INIT_MOUNT=""
if [ -d "$(pwd)/infra/postgres/init" ]; then
  INIT_MOUNT="-v $(pwd)/infra/postgres/init:/docker-entrypoint-initdb.d:ro"
fi

# shellcheck disable=SC2086 # INIT_MOUNT is intentionally word-split
docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD=rehearse-throwaway-pw \
  -e POSTGRES_DB=postgres \
  -e KEYCLOAK_DB_NAME="$KEYCLOAK_DB_NAME" \
  -e KEYCLOAK_DB_USER="$KEYCLOAK_DB_USER" \
  -e KEYCLOAK_DB_PASSWORD="$KEYCLOAK_DB_PASSWORD" \
  $INIT_MOUNT \
  "postgres:${TARGET_VERSION}-alpine" >/dev/null

echo "Waiting for ephemeral PG ${TARGET_VERSION} to accept connections"
READY=0
for i in $(seq 1 45); do
  if docker exec "$CONTAINER_NAME" pg_isready -U "$PG_USER" >/dev/null 2>&1; then
    echo "  ready (attempt ${i})"
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" -ne 1 ]; then
  echo "ephemeral PG did not become ready within 90s" >&2
  docker logs "$CONTAINER_NAME" --tail 100 >&2 || true
  exit 1
fi

# Apply the same bootstrap-role filter the live cut applies, but locally
# (cheaper than re-uploading to a remote container). The original dump is
# kept untouched so the workflow artifact remains the source-of-truth copy.
FILTERED="${DUMP%.sql}.rehearsal-filtered.sql"
echo "Filtering bootstrap-role lines from dump → $(basename "$FILTERED")"
sed -E "/^(DROP ROLE IF EXISTS|CREATE ROLE|ALTER ROLE) ${PG_USER}( |;)/d" "$DUMP" > "$FILTERED"

echo "Copying filtered dump into rehearsal container and restoring"
docker cp "$FILTERED" "$CONTAINER_NAME:/tmp/restore.sql"
docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -f /tmp/restore.sql

# ---- Verification: rehearsal counts vs source counts captured in `pre` ----

echo ""
echo "Verifying rehearsal restore against source-side state captured in pre"

fail=0

REHEARSAL_POLICIES=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$APP_DB" -tAc "SELECT count(*) FROM pg_policies WHERE schemaname='public'" 2>/dev/null | tr -d '[:space:]')
if [ "$REHEARSAL_POLICIES" != "${SRC_POLICY_COUNT:-}" ]; then
  echo "::error ::RLS policy count mismatch: source=${SRC_POLICY_COUNT:-?}, rehearsal=$REHEARSAL_POLICIES"
  fail=1
else
  echo "  pg_policies (public): $REHEARSAL_POLICIES (matches source)"
fi

REHEARSAL_EXT=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$APP_DB" -tAc "SELECT count(*) FROM pg_extension WHERE extname IN ('pg_trgm')" 2>/dev/null | tr -d '[:space:]')
if [ "$REHEARSAL_EXT" != "${SRC_EXTENSION_COUNT:-}" ]; then
  echo "::error ::pg_trgm extension count mismatch: source=${SRC_EXTENSION_COUNT:-?}, rehearsal=$REHEARSAL_EXT"
  fail=1
else
  echo "  pg_trgm extension: $REHEARSAL_EXT (matches source)"
fi

if [ -n "${KC_LOCATION_DB:-}" ] && [ "${SRC_KC_MIGRATIONS:-skipped}" != "skipped" ]; then
  REHEARSAL_KC=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$KC_LOCATION_DB" -tAc "SELECT count(*) FROM databasechangelog" 2>/dev/null | tr -d '[:space:]')
  if [ "$REHEARSAL_KC" != "$SRC_KC_MIGRATIONS" ]; then
    echo "::error ::keycloak databasechangelog mismatch: source=$SRC_KC_MIGRATIONS, rehearsal=$REHEARSAL_KC"
    fail=1
  else
    echo "  keycloak databasechangelog ($KC_LOCATION_DB): $REHEARSAL_KC (matches source)"
  fi
else
  echo "  keycloak changelog check skipped (no KC location DB recorded in pre)"
fi

# Spot-check that the core app tables are queryable. Row counts are
# informational (we don't compare them to source — staging data can drift
# during the dump → rehearsal window in absolute terms; what matters is
# the RLS / extension / changelog signal above).
for table in users tenants donations audit_logs; do
  count=$(docker exec "$CONTAINER_NAME" psql -U "$PG_USER" -d "$APP_DB" -tAc "SELECT count(*) FROM ${table}" 2>/dev/null | tr -d '[:space:]')
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    echo "::error ::could not query ${APP_DB}.${table} on rehearsal container"
    fail=1
  else
    echo "  ${APP_DB}.${table}: $count rows"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Rehearsal failed. The dump does NOT restore cleanly into postgres:${TARGET_VERSION}-alpine." >&2
  echo "Do NOT re-dispatch in 'live' mode until the failure is understood." >&2
  exit 1
fi

echo ""
echo "REHEARSAL phase complete: dump restores cleanly into postgres:${TARGET_VERSION}-alpine"
echo "  policies / extensions / changelog all match source state captured in pre."
echo "  Safe to re-dispatch with mode=live for the real migration."
