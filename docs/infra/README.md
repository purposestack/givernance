# Givernance Infrastructure

This folder documents the infrastructure for the Givernance platform.

## SaaS Target (Scaleway EU)
Givernance is primarily hosted on Scaleway to ensure **100% EU Data Residency and GDPR compliance** via their standard DPA.
The target SaaS architecture includes:
- **Managed PostgreSQL 16 EU**: Primary database (multi-tenant RLS).
- **Managed Redis 7 EU**: Cache, Session, and BullMQ event bus.
- **Scaleway Object Storage EU**: S3-compatible, for receipts and CSVs.

## Local Development (Docker Compose)
For local development, we mirror this stack via Docker Compose.

**Quickstart**:
```bash
./scripts/dev-up.sh
```

**Services Available Locally**:
- **Postgres 16**: `localhost:5432` (`givernance/givernance`)
- **Redis 7**: `localhost:6379`
- **MinIO**: `localhost:9000` (UI at `9001` with `admin/password`)
- **Mailpit**: `localhost:8025` (SMTP catcher at `1025`)

**Teardown**:
```bash
./scripts/dev-down.sh
```

See [ADR-009](../15-infra-adr.md) for detailed cloud provider comparisons.
