#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

echo "Stopping Givernance local dev stack..."
docker compose --profile proxy down

echo ""
echo "Stack stopped. Data volumes preserved."
echo "To remove volumes: docker compose down -v"
