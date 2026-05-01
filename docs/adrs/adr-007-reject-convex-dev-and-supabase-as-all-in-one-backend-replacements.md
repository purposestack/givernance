## ADR-007: Reject Convex.dev and Supabase as All-in-One Backend Replacements

- **Status**: Accepted
- **Date**: 2026-03-09
- **Deciders**: Magino (founder/architect)

### Context

Evaluated Convex.dev and Supabase as potential all-in-one backend platforms to reduce infrastructure complexity for Phase 0.

### Decision

Reject both as primary backend replacements. Supabase PostgreSQL remains a valid managed database option (equivalent to Neon.tech — see ADR-009).

### Rationale — Convex.dev rejected

Self-hosted Convex now exists (Docker + PostgreSQL backend, released Feb 2025). Still rejected because:

| Criterion | Assessment |
|---|---|
| Application-level RLS | ❌ Application-level RLS vs PostgreSQL native RLS — weaker security boundary for multi-tenant GDPR data |
| Data model fit | ❌ Document/reactive model doesn't map cleanly to relational NPO data (households→persons→donations→fund allocations) |
| Self-hosted HA | ❌ Single-machine by default for self-hosted, complex HA |
| Audit logs | ❌ Audit logs need external integration for self-hosted (not built-in — incompatible with 7-year GDPR retention requirement) |
| PostgreSQL extensions | ❌ pg_audit, pg_trgm extensions unavailable via Convex abstraction |
| EU data residency | ❌ Cloud-hosted Convex is US-only; self-hosted addresses this but introduces operational burden |
| Vendor lock-in | ❌ Proprietary query language, reactive model, and function format — even self-hosted uses Convex's proprietary stack |

**Status: Rejected.** Re-evaluate only if Phase 4 real-time requirements cannot be met by NATS JetStream.

### Rationale — Supabase all-in-one rejected

| Component | Assessment |
|---|---|
| Self-hosted Supabase | ❌ 12+ containers (Kong, GoTrue, PostgREST, Realtime, Storage, Studio, etc.) — more complex than the current stack |
| Supabase Auth (GoTrue) | ❌ Missing: SAML 2.0 bridge, MFA enforcement by role, magic-link for volunteers, brute-force protection by role — all specified in auth requirements |
| Supabase Realtime | ❌ Postgres LISTEN/NOTIFY: no durability, no dead-letter, no at-least-once semantics — insufficient to replace the transactional outbox |
| Supabase PostgreSQL only | ✅ Valid as managed Postgres (same as Neon.tech) — see ADR-009 |

### Consequences

- ✅ Keycloak retained — full auth feature set preserved (SAML 2.0, MFA, magic-link, brute-force protection)
- ✅ PostgreSQL with RLS, pg_audit, pg_trgm retained — GDPR tenant isolation and audit patterns preserved
- ✅ Self-hosted deployment path preserved — no cloud-only dependency
- ✅ TypeScript full-stack retained — shared types and monorepo benefits preserved (see ADR-002)
- ⚠️ Auth infrastructure requires self-hosting Keycloak — adds one container to manage in all deployment modes

---

