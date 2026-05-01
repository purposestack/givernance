## ADR-007: Reject Convex.dev and Supabase as All-in-One Backend Replacements (Updated Context)

- **Status:** Accepted
- **Date:** 2026-03-09 (Re-evaluated: 2026-04-08)
- **Deciders**: Magino (founder/architect)

### Context

Evaluated Convex.dev and Supabase as potential all-in-one backend platforms. Supabase PostgreSQL remains a valid managed database option as part of the Scaleway selection (ADR-009).

### Rationale — Convex.dev rejected

- **Application-level RLS**: Weaker security boundary for multi-tenant GDPR data vs PostgreSQL native RLS.
- **Data model fit**: Document/reactive model doesn't map cleanly to relational NPO data.
- **Self-hosted HA**: Complex HA for self-hosted setup.
- **Audit logs**: Requires external integration, incompatible with GDPR retention.
- **PostgreSQL extensions**: `pg_audit`, `pg_trgm` unavailable.
- **Vendor lock-in**: Proprietary query language and function format.

**Status: Rejected.** Re-evaluate only if Phase 4 real-time requirements cannot be met by NATS JetStream.

### Rationale — Supabase all-in-one rejected

- **Self-hosted complexity**: 12+ containers more complex than current stack.
- **Supabase Auth (GoTrue)**: Missing key auth requirements (SAML 2.0 bridge, MFA enforcement, magic-link, brute-force protection).
- **Supabase Realtime**: Insufficient for transactional outbox pattern (no durability, no dead-letter, no at-least-once).
- **Supabase PostgreSQL only**: Remains a valid managed Postgres option (comparable to Scaleway Managed PostgreSQL under ADR-009).

### Consequences

- ✅ Keycloak retained for full auth feature set.
- ✅ PostgreSQL with RLS, pg_audit, pg_trgm retained for GDPR tenant isolation and audit patterns.
- ✅ Self-hosted deployment path preserved.
- ✅ TypeScript full-stack retained.
- ⚠️ Auth infrastructure requires self-hosting Keycloak.

---

