## ADR-002: TypeScript Full-Stack over Go Backend

- **Status**: Accepted
- **Date**: 2026-03
- **Deciders**: Magino (founder/architect)

### Context

Givernance's frontend is already TypeScript (Next.js 16). The original backend was planned in Go 1.23 for raw performance and small binary size. As a Phase 0 project with a single developer, the cost of context-switching between Go (backend) and TypeScript (frontend) is significant. The team needs to maximize velocity and minimize cognitive overhead.

### Decision

Use **TypeScript (Node.js 22 LTS + Fastify 5)** for the backend, creating a full-stack TypeScript monorepo managed with pnpm workspaces.

### Rationale

- **Single language across the stack** → eliminates context switching for a solo/small team
- **Shared types** between frontend (Next.js) and backend (Fastify) via `packages/shared` — a single TypeBox schema defines API contract, request validation, OpenAPI generation, and form validation
- **TypeScript type safety + TypeBox runtime validation** covers Go's compile-time safety advantage with the added benefit of runtime enforcement and native Fastify JSON serialization performance
- **Fastify 5 benchmarks at ~77,000 req/s** on Node.js 22 — well above the target NPO workload of ~500 req/s at peak (200-staff org, 50 concurrent users)
- **BullMQ** (TypeScript-native) is a direct functional equivalent to Asynq (Go) — both Redis-backed, both support cron, retries, and concurrency control
- **Drizzle ORM** provides Go-like type safety for SQL queries in TypeScript, with explicit SQL semantics (no magic)
- **Ecosystem advantage**: TypeScript has a significantly larger developer pool than Go; easier hiring for a European NPO-focused startup
- **Immediate benefit**: TypeBox schemas reused from API validation in Next.js forms create a single source of truth for data contracts

> **Implementation note (2026-04-14)**: Zod was initially selected but **abandoned during Phase 1** in favor of `@sinclair/typebox`. TypeBox provides native Fastify integration (JSON serialization + OpenAPI 3.1 schema generation without conversion), better performance (no runtime Zod→JSON Schema transformation), and direct Swagger/OpenAPI compatibility. All validators in `packages/shared/src/validators/` and all route schemas in `packages/api/` use TypeBox exclusively.

### Tradeoffs

| Option | Pros | Cons | Verdict |
|---|---|---|---|---|
| Go 1.23 (original plan) | Best raw performance (~300k req/s), compiled binary, ~10 MB Docker image, low memory footprint | Separate language from frontend, no shared types, smaller developer pool in EU, no type sharing with Next.js | Rejected |
| **TypeScript + Fastify 5** | Full-stack TS, shared types via monorepo, large ecosystem, ~77k req/s sufficient for target workload | Runtime overhead vs Go, GC pauses possible at scale, larger Docker image (~150 MB Alpine) | **Selected** |
| Python (FastAPI) | Easy ML/AI integration, familiar to data scientists | ~8k req/s (too slow for API layer), no frontend type sharing, GIL limitations | Rejected |
| Bun runtime | Faster than Node.js (~2x in benchmarks), built-in TypeScript support | Less mature ecosystem, fewer production deployments, limited corporate adoption | Re-evaluate at Phase 4 |

### Consequences

- Docker image will be larger (~150 MB vs ~10 MB for Go) — mitigated by Alpine base image + multi-stage build
- Memory usage higher than Go (~100–200 MB vs ~20–50 MB) — mitigated by PgBouncer connection pooling, Redis caching, and horizontal scaling at Phase 3+
- CPU-bound tasks (PDF generation, large CSV exports) may need worker threads or dedicated BullMQ processors with sandboxed execution
- **Performance re-evaluation at Phase 3**: load test against NFRs (p99 < 200 ms, 500 req/s sustained) — if Node.js 22 falls short, consider Bun runtime or extracting hot paths
- All existing architecture documents (02-reference-architecture, 04-business-capabilities) must be updated to reflect the TypeScript stack

---

