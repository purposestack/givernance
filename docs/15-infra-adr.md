# 15 — Architecture Decision Records

This document serves as an index for the Givernance Architecture Decision Records (ADRs).

## Index

- [ADR-001: Modular Monolith over Microservices](./adrs/adr-001-modular-monolith-over-microservices.md)
- [ADR-002: TypeScript Full-Stack over Go Backend](./adrs/adr-002-typescript-full-stack-over-go-backend.md)
- [ADR-003: Drizzle ORM over Raw SQL or Prisma](./adrs/adr-003-drizzle-orm-over-raw-sql-or-prisma.md)
- [ADR-004: Job Queue System (BullMQ) — Superseded by ADR-008](./adrs/adr-004-job-queue-system-bullmq-superseded-by-adr-008.md)
- [ADR-005: NATS JetStream — Deferred to Phase 4](./adrs/adr-005-nats-jetstream-deferred-to-phase-4.md)
- [ADR-007: Reject Convex.dev and Supabase as All-in-One Backend Replacements](./adrs/adr-007-reject-convex-dev-and-supabase-as-all-in-one-backend-replacements.md)
- [ADR-008: Job Queue System (pg-boss)](./adrs/adr-008-job-queue-system-pg-boss.md)
- [ADR-009: Scaleway as Primary SaaS Managed Cloud Provider](./adrs/adr-009-scaleway-as-primary-saas-managed-cloud-provider.md)
- [ADR-011: Layered Service Architecture over MVC for Frontend](./adrs/adr-011-layered-service-architecture-over-mvc-for-frontend.md)
- [ADR-012: shadcn/ui + TanStack Ecosystem for UI Components](./adrs/adr-012-shadcn-ui-tanstack-ecosystem-for-ui-components.md)
- [ADR-013: Frontend Type Boundary — No Drizzle Imports in Web Package](./adrs/adr-013-frontend-type-boundary-no-drizzle-imports-in-web-package.md)
- [ADR-015: Internationalization & Translation Strategy](./adrs/adr-015-internationalization-translation-strategy.md)
- [ADR-016: Tenant Onboarding & Multi-Tenancy — Hybrid Self-Serve + Enterprise Model](./adrs/adr-016-tenant-onboarding-multi-tenancy-hybrid-self-serve-enterprise-model.md)
- [ADR-017: One Logical Database per Tool — Isolate Keycloak from the Application DB](./adrs/adr-017-one-logical-database-per-tool-isolate-keycloak-from-the-application-db.md)
- [ADR-018: Offset Pagination for Phase 1 — Cursor Deferred](./adrs/adr-018-offset-pagination-for-phase-1-cursor-deferred.md)
- [ADR-019: Cross-Tenant Foreign-Key Violations Return 404 (Not 422)](./adrs/adr-019-cross-tenant-foreign-key-violations-return-404-not-422.md)
- [ADR-020: BullMQ Dead-Letter Strategy — `failed` Set + Structured Alerting for Phase 1](./adrs/adr-020-bullmq-dead-letter-strategy-failed-set-structured-alerting-for-phase-1.md)
- [ADR-021: User Lifecycle — Soft-delete in App, Hard-delete in Keycloak, Anonymisation for GDPR](./adrs/adr-021-user-lifecycle-soft-delete-in-app-hard-delete-in-keycloak-anonymisation-for-gdpr.md)
