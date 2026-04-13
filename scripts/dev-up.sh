#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

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
echo "====================================="
echo " Givernance — Local Dev Stack"
echo "====================================="
echo ""
echo " PostgreSQL   localhost:${POSTGRES_PORT:-5432}   (DB: ${POSTGRES_DB:-givernance})"
echo " Redis        localhost:${REDIS_PORT:-6379}"
echo " Keycloak     http://localhost:${KEYCLOAK_PORT:-8080}   (admin/admin)"
echo " MinIO API    http://localhost:${MINIO_API_PORT:-9000}"
echo " MinIO UI     http://localhost:${MINIO_CONSOLE_PORT:-9001}   (givernance/givernance_dev)"
echo " Mailpit SMTP localhost:${MAILPIT_SMTP_PORT:-1025}"
echo " Mailpit UI   http://localhost:${MAILPIT_UI_PORT:-8025}"
echo ""
echo " Start API + Worker:  pnpm dev"
echo " Caddy proxy (optional): docker compose --profile proxy up -d"
echo ""
echo "====================================="
