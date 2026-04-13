#!/bin/bash
set -e

echo "🚀 Starting Givernance local infrastructure..."
docker compose up -d

echo "⏳ Waiting for PostgreSQL to be ready..."
sleep 5

echo "✅ Local Dev Infra is running!"
echo "   - PostgreSQL: localhost:5432"
echo "   - Redis:      localhost:6379"
echo "   - MinIO S3:   localhost:9000 (UI: 9001, admin/password)"
echo "   - Mailpit:    localhost:8025 (SMTP: 1025)"
