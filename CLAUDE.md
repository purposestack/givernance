# Givernance — CLAUDE.md

Givernance is a purpose-built CRM for European nonprofits (2-200 staff), designed as a GDPR-native, affordable alternative to Salesforce NPSP. The project is currently in Phase 0 (Foundation / Architecture Blueprint) — no production code yet, only design documents, mockups, and architecture specs.

## Tech Stack (Target)

| Layer | Technology |
|-------|-----------|
| API | TypeScript (Node.js 22 LTS), Fastify 5, modular monolith |
| Worker | TypeScript, BullMQ 5 (Redis-backed) |
| Web | Next.js 16 (React, TypeScript) |
| Database | PostgreSQL 16 + Drizzle ORM (SaaS: Scaleway Managed PostgreSQL EU · Self-hosted: Postgres 16 + PgBouncer) |
| Job Queue / Events | BullMQ 5 + Redis (Phase 0-3) — NATS JetStream added Phase 4+ |
| Cache / Rate-limit | Redis (SaaS: Scaleway Managed Redis EU · Self-hosted: Redis 7) |
| Storage | Scaleway Object Storage EU (SaaS) · MinIO (Self-hosted) |
| Auth | Keycloak 26 (OIDC / SAML — all deployments, self-hosted on Scaleway VMs for SaaS). Organizations feature enabled (ADR-016 / issue #114); each Givernance tenant maps 1:1 to a Keycloak Organization. |
| Observability | Scaleway Cockpit (Grafana + Loki + Mimir + Tempo) — SaaS managed |
| AI Inference EU | Scaleway Generative APIs (Mistral, Llama 3.1) — GDPR Art. 9, beneficiary data |
| Deployment | Docker Compose (self-hosted) · Kamal + Scaleway EU VMs (SaaS) |
| Infra | Docker, pnpm workspaces monorepo, single Scaleway GDPR DPA |

## Directory Structure

```
├── CLAUDE.md              ← You are here
├── README.md              ← Project overview, getting started, doc index
├── packages/
│   ├── shared/            ← Drizzle schema, Zod validators, shared types, domain events
│   ├── api/               ← Fastify 5 API server (all domain modules)
│   ├── worker/            ← BullMQ job processor
│   └── migrate/           ← One-off Salesforce ETL tool
├── package.json           ← pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── docs/
│   ├── 01-product-scope.md       — Problem statement, personas, MoSCoW scope
│   ├── 02-reference-architecture.md — C4 diagrams, modular monolith, API design
│   ├── 03-data-model.md          — Core ERD, multi-tenancy, audit patterns
│   ├── 04-business-capabilities.md — Module breakdown, API contracts
│   ├── 05-integration-migration.md — Salesforce migration, ETL, integrations
│   ├── 06-security-compliance.md  — GDPR, RBAC, encryption, audit
│   ├── 07-delivery-roadmap.md     — Phase plan, milestones, team
│   ├── 08-pricing-packaging.md    — Tier structure, pricing model
│   ├── 09-risk-register.md        — Technical and business risks
│   ├── 10-open-questions.md       — Unresolved decisions
│   ├── 11-design-identity.md      — Visual identity, design tokens, components
│   ├── 12-user-journeys.md        — 5 persona journeys with Mermaid flows
│   ├── 13-ai-modes.md            — Manual / Assisted / Autopilot AI modes
│   ├── 14-screen-inventory.md     — Complete 86-screen inventory
│   ├── 15-infra-adr.md           — Architecture Decision Records (ADR-001, ADR-002, ADR-003)
│   ├── 16-greg-field-insights.md — Field insights: fundraising channels, migration, pricing (Greg)
│   ├── 17-log-management.md      — Log management strategy, structured logging, audit trail, GDPR
│   ├── 18-feature-flags.md        — Feature flag strategy: schema, evaluation, backend/frontend enforcement, lifecycle
│   ├── 19-impersonation.md         — Impersonation strategy: token design, session lifecycle, double-attribution, GDPR
│   ├── 20-payment-strategy.md      — Payment systems: Stripe/Mollie/Mangopay comparison, ADR-010, PCI DSS, GDPR
│   ├── vision/
│   │   └── conversational-mode.md — Future conversational AI mode (2026-2028)
│   ├── security/                  — Security audits & RBAC matrices (non-numbered, dated; e.g. rbac-audit-2026-04-27.md)
│   └── design/                    — 86 interactive HTML mockups
├── diagrams/
│   ├── context.mmd       — C4 system context
│   ├── container.mmd     — C4 container diagram
│   ├── core-erd.mmd      — Entity-relationship diagram
│   └── migration-flow.mmd — Salesforce migration flow
└── .claude/agents/        — 12 specialized Claude agents
```

## Specialized Agents

Use these agents for domain-specific tasks via Claude Code:

| Agent | File | Purpose |
|-------|------|---------|
| Domain Analyst | `.claude/agents/domain-analyst.md` | Business domain, bounded contexts |
| Data Architect | `.claude/agents/data-architect.md` | Data model, database design |
| Platform Architect | `.claude/agents/platform-architect.md` | System architecture, infrastructure |
| Migration Architect | `.claude/agents/migration-architect.md` | Salesforce migration strategy |
| Security Architect | `.claude/agents/security-architect.md` | Security, GDPR compliance |
| Pricing Strategist | `.claude/agents/pricing-strategist.md` | Pricing model, packaging |
| UX Researcher | `.claude/agents/ux-researcher.md` | User research, personas, usability |
| Design Architect | `.claude/agents/design-architect.md` | Visual identity, design system |
| MVP Engineer | `.claude/agents/mvp-engineer.md` | Full-stack implementation, Fastify routes, Drizzle ORM, BullMQ jobs |
| API Contract Designer | `.claude/agents/api-contract-designer.md` | REST API contracts, TypeBox schemas, OpenAPI 3.1, RFC 9457 errors |
| QA Engineer | `.claude/agents/qa-engineer.md` | Integration tests, RLS isolation, GDPR compliance, Stripe webhooks |
| Log Analyst | `.claude/agents/log-analyst.md` | Structured logging, distributed tracing, audit trail, GDPR log compliance, performance diagnostics |
| Feature Flag Engineer | `.claude/agents/feature-flag-engineer.md` | Feature flags: schema, evaluation, backend/frontend enforcement, lifecycle, plan-gating |
| Impersonation Engineer | `.claude/agents/impersonation-engineer.md` | Impersonation: token design, session lifecycle, double-attribution audit trail, GDPR |
| Payment Engineer | `.claude/agents/payment-engineer.md` | Payments: Stripe Connect, Mollie, SEPA DD, webhooks, PCI DSS SAQ A, reconciliation |

## Implementation Status

**Phase 0 — Foundation (current)**: Architecture blueprint complete. 17 specification documents, 86 HTML mockups, 4 Mermaid diagrams. No production code yet.

Next: Phase 1 — Skeleton (TypeScript monorepo scaffolding with pnpm workspaces, Drizzle schema baseline, CI/CD, auth, first module).

## Design Mockups

HTML mockups are in `docs/design/`. Open `docs/design/index.html` locally or view on GitHub Pages: https://onigam.github.io/givernance/design/

### 🛑 Mockup-First Rule (CRITICAL FOR FRONTEND)

**Before implementing any UI component or page, you MUST read the corresponding HTML mockup in `docs/design/`.** GitHub issues reference mockups in their "Mockup References" table — use those paths to find the source file. The mockup is the visual spec: match its layout, illustrations, typography, spacing, copy structure, and interactions. Do NOT improvise placeholder UI when a mockup exists.

Checklist for every frontend implementation:
1. Read the issue's "Mockup References" table to identify which mockup files apply
2. `Read` each mockup HTML file to understand the exact layout, CSS art, copy, and interactions
3. Implement to match the mockup — structure, visual hierarchy, and component choices
4. Verify in the browser that the rendered page matches the mockup

### 🛑 ADR-First Rule (CRITICAL FOR ALL IMPLEMENTATION)

**Before implementing any feature, you MUST read the relevant Architecture Decision Records in `docs/15-infra-adr.md`.** GitHub issues reference ADRs in their "Architecture References" table. ADRs define non-obvious constraints (env var names, security patterns, color semantics, import boundaries) that cannot be guessed from context.

Checklist for every implementation:
1. Read the issue's "Architecture References" table to identify which ADRs apply
2. `Read` the full ADR sections in `docs/15-infra-adr.md` — pay attention to env var names, security patterns, rejected alternatives, and consequences
3. When briefing subagents, include the specific ADR constraints in the prompt (subagents cannot read CLAUDE.md)
4. If any ADR constraint conflicts with another source of truth (e.g., tokens.css vs ADR text), flag it explicitly rather than silently picking one

Key ADRs for frontend work:
- **ADR-011**: 4-layer architecture, `API_URL` (server) vs `NEXT_PUBLIC_API_URL` (browser), CSRF double-submit pattern, JWT cookie handling
- **ADR-012**: shadcn/ui + TanStack ecosystem, component hierarchy, design token integration, accessibility requirements
- **ADR-013**: Frontend type boundary, Biome `noRestrictedImports`, no source maps in production

## Conventions

- Project name: **Givernance** (not "Libero", not "givernance-npo-platform")
- Terminology: **NPO** (nonprofit organization), not "NGO"
- GDPR in English docs, RGPD in French docs
- All docs are in `docs/`, numbered 01-22 for architecture specs

### 🛑 One Logical Database per Tool (ADR-017)

**Never co-locate an application schema with a third-party service's schema in the same Postgres logical database.** Each tool that needs Postgres storage gets its own logical DB and its own owner role on the shared instance.

Current topology:
- `givernance` — application data (Drizzle-managed), owner `givernance`, runtime role `givernance_app` (NOBYPASSRLS)
- `givernance_keycloak` — Keycloak's internal tables, owner `keycloak` (provisioned by `infra/postgres/init/01-init-keycloak-db.sh`)

When proposing a new service or Compose change that needs Postgres storage (e.g., adding Mailpit with a durable store, a second IdP, a workflow engine, an analytics sidecar), **do not reuse `givernance` or `givernance_keycloak`** — add a new logical DB + role in `infra/postgres/init/`, document it in the "Databases" table of `docs/infra/README.md`, and reference ADR-017. Co-locating is rejected in PR review. Rationale, rejected alternatives, and revisit criteria are in [`docs/15-infra-adr.md` → ADR-017](docs/15-infra-adr.md#adr-017-one-logical-database-per-tool--isolate-keycloak-from-the-application-db).

### 🛑 Closing multiple issues in one PR

**Never use a comma-separated list or the `fix` / `fixes` keyword to close multiple issues from a PR description.** GitHub's auto-close behavior is unreliable on this repo for those forms — only some of the referenced issues actually close at merge time.

Instead, write one `close` directive **per line**, with one issue number per directive:

```
close #161
close #181
close #182
```

Apply this in `gh pr create` / `gh pr edit` bodies, in commit messages that close issues, and in any PR template. Use `close` (not `closes`, not `fix`, not `fixes`).

### 🛑 No secrets in Keycloak Organization attributes (issue #114)

**Never put secrets, API keys, billing tokens, or any sensitive data into a Keycloak Organization's `attributes` map.** The `organization` client scope (attached as default to `givernance-web` and as optional to `admin-cli`) carries an `oidc-organization-membership-mapper` configured with `addOrganizationAttributes=true`, which emits every organization attribute into every access, ID, and introspection token for members of that org. Any secret stashed there will leak to the browser and every downstream service that sees the JWT.

Valid uses for Organization attributes: non-sensitive identifiers (`org_id`, slug), feature flags that don't imply entitlements (`theme`, `locale`), public-facing labels. Anything else belongs in the application database (`tenants` table) with RLS.

---

## 🛑 DEV PROCESS (CRITICAL FOR CI)

**Every time you commit code in this repository, YOU MUST ENSURE the GitHub Actions CI pipeline will pass.**

Before concluding your task or pushing to origin, you must run and verify:
1. `pnpm install` (to sync dependencies)
2. `pnpm build` (to check compilation)
3. `pnpm run format` (to fix any Biome formatting)
4. `pnpm run lint` (to fix any Biome linter rules)
5. `pnpm typecheck` (to catch TypeScript strict errors)
6. `pnpm test` (to ensure the integration tests still pass)

If any of these fail, **fix the underlying issue** before pushing. Never leave a branch with a failing `typecheck` or `lint` command.
