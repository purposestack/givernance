# 09 — Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| Migration complexity underestimated | M | H | Pilot-first migration, phased cutover, rollback plan |
| Data quality issues in source CRM | H | M | Pre-migration profiling + cleansing sprint |
| Security/compliance gaps | M | H | Control baseline + third-party audit |
| Over-customization pressure | H | M | Template-first policy + change governance |
| Integration fragility | M | M | Adapter pattern + retry/idempotency |
| Support burden at launch | M | M | Onboarding playbooks + knowledge base |
| Node.js TypeScript performance vs compiled languages | L | M | Fastify 5 (one of fastest Node.js frameworks), connection pooling via PgBouncer, horizontal scaling |
| Type safety at runtime | M | M | Zod validation at API boundaries + Drizzle ORM type-safe queries |
