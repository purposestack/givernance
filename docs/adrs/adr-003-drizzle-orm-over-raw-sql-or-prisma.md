## ADR-003: Drizzle ORM over Raw SQL or Prisma

- **Status**: Accepted
- **Date**: 2026-03
- **Deciders**: Magino (founder/architect)

### Context

Givernance requires type-safe database access in TypeScript with PostgreSQL 17. The data model relies on PostgreSQL-specific features including Row-Level Security (RLS) with `SET LOCAL` per transaction for multi-tenancy, `uuid-ossp` for primary keys, and `pg_trgm` for fuzzy search.

### Decision

Use **Drizzle ORM** for database access and **Drizzle Kit** for schema migrations (replacing golang-migrate from the original Go plan).

### Rationale

- **Closest to SQL**: Drizzle's query builder maps 1:1 to SQL semantics — no "magic" abstraction layer, what you write is what executes
- **Full type inference**: Schema definitions generate TypeScript types automatically; query results are fully typed without code generation steps
- **Drizzle Kit migrations**: Schema-driven migration generation replaces hand-written SQL migrations (golang-migrate), with the option to customize generated SQL
- **No N+1 magic**: Relations are explicit, not auto-loaded — prevents accidental performance issues common in ORMs like Prisma and TypeORM
- **PostgreSQL-native**: Works with RLS (`SET LOCAL` within transactions), `pg_trgm` operators, `uuid-ossp`, and raw SQL escape hatches when needed
- **Lightweight**: No code generation step, no heavy runtime, no binary dependency

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Prisma** | Large community, excellent DX for simple CRUD | Heavy code generation step, poor support for `RLS SET LOCAL` per-transaction, Prisma Client binary (~15 MB), schema language is not TypeScript | Rejected |
| **TypeORM** | Mature, decorator-based entity definitions | Poor TypeScript type inference, decorator-heavy syntax, declining maintenance activity | Rejected |
| **Raw pg (node-postgres)** | Maximum control, no abstraction overhead | No type safety for queries, verbose boilerplate for every query, manual migration management | Rejected |
| **Kysely** | Type-safe query builder, lightweight | Less mature migration tooling, smaller ecosystem than Drizzle | Considered — revisit if Redis is removed from stack |
| **Drizzle ORM** | SQL-like API, full type inference, Drizzle Kit migrations, PostgreSQL-native features | Younger project than Prisma, smaller community | **Selected** |

### Consequences

- Schema definitions live in `packages/shared/src/schema/` as TypeScript files — these are the source of truth for both migrations and application types
- Migration workflow: modify schema → `drizzle-kit generate` → review SQL → `drizzle-kit migrate`
- RLS enforcement pattern: The API uses the `givernance_app` PostgreSQL role (NOBYPASSRLS) and wraps queries in `withTenantContext(orgId, callback)`, which calls `set_config('app.current_org_id', orgId, true)` inside a Drizzle transaction. A global Fastify `preHandler` with session-level `SET LOCAL` was explicitly rejected as unsafe with PgBouncer transaction-mode pooling. See [03-data-model.md §4](./03-data-model.md) for the full 3-role pattern.
- Team members must learn Drizzle's API (smaller community means fewer Stack Overflow answers, but official docs are comprehensive)

---

