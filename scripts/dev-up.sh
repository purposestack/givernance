#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "📦 Installing dependencies..."
  pnpm install
fi

# Copy .env if it doesn't exist
if [ ! -f .env ]; then
  echo "No .env file found — copying from .env.example"
  cp .env.example .env
fi

echo "Starting Givernance local dev stack..."
docker compose up -d

echo ""
echo "Waiting for PostgreSQL..."
until docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-givernance}" -q 2>/dev/null; do
  sleep 1
done
echo "PostgreSQL is ready."

echo ""
echo "Waiting for Redis..."
until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do
  sleep 1
done
echo "Redis is ready."

echo ""
echo "Running database migrations..."
pnpm db:migrate
echo "Migrations complete."

echo ""
echo "Creating test database if it doesn't exist..."
docker compose exec -T postgres psql -U "${POSTGRES_USER:-givernance}" -d postgres \
  -tc "SELECT 1 FROM pg_database WHERE datname='givernance_test'" | grep -q 1 || \
  docker compose exec -T postgres psql -U "${POSTGRES_USER:-givernance}" -d postgres \
  -c "CREATE DATABASE givernance_test"

echo "Running migrations on test database..."
DATABASE_URL="postgresql://${POSTGRES_USER:-givernance}:${POSTGRES_PASSWORD:-givernance_dev}@localhost:5432/givernance_test" \
  pnpm --filter @givernance/api db:migrate

echo "Waiting for Keycloak to initialize its database schema..."
# Keycloak has its own logical database (ADR-017). We connect as the Postgres
# superuser (POSTGRES_USER) — it can read any DB regardless of ownership.
until docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-givernance}" \
  -d "${KEYCLOAK_DB_NAME:-givernance_keycloak}" \
  -tc "SELECT 1 FROM realm WHERE name='master'" 2>/dev/null | grep -q 1; do
  sleep 2
done

echo "Relaxing Keycloak SSL requirement for local dev..."
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-givernance}" \
  -d "${KEYCLOAK_DB_NAME:-givernance_keycloak}" \
  -c "UPDATE realm SET ssl_required='NONE' WHERE name='master';"
docker compose restart keycloak > /dev/null

echo "Waiting for Keycloak realm '${KEYCLOAK_REALM:-givernance}' to be reachable..."
KC_URL="${KEYCLOAK_URL:-http://localhost:${KEYCLOAK_PORT:-8080}}"
REALM_NAME="${KEYCLOAK_REALM:-givernance}"
until curl -sf -o /dev/null "${KC_URL}/realms/${REALM_NAME}/.well-known/openid-configuration"; do
  sleep 2
done

echo "Syncing Keycloak realm state (idempotent)..."
KEYCLOAK_URL="$KC_URL" "$SCRIPT_DIR/keycloak-sync-realm.sh"

echo ""
echo "====================================="
echo " Givernance — Local Dev Stack"
echo "====================================="
echo ""
echo " PostgreSQL   localhost:${POSTGRES_PORT:-5432}   (app DB: ${POSTGRES_DB:-givernance} · Keycloak DB: ${KEYCLOAK_DB_NAME:-givernance_keycloak})"
echo " Redis        localhost:${REDIS_PORT:-6379}"
echo " Keycloak     http://localhost:${KEYCLOAK_PORT:-8080}   (admin/admin)"
echo " MinIO API    http://localhost:${MINIO_API_PORT:-9000}"
echo " MinIO UI     http://localhost:${MINIO_CONSOLE_PORT:-9001}   (givernance/givernance_dev)"
echo " Mailpit SMTP localhost:${MAILPIT_SMTP_PORT:-1025}"
echo " Mailpit UI   http://localhost:${MAILPIT_UI_PORT:-8025}"
echo ""
echo " Start API + Worker + Relay:  pnpm dev"
echo " Caddy proxy (optional): docker compose --profile proxy up -d"
echo ""
echo "====================================="
