# Givernance NPO Platform Blueprint

<img src="docs/design/shared/assets/logo-symbol.png" alt="Givernance Logo" width="80">

> **Phase 0 — Foundation | In Planning**

Givernance — purpose-built CRM for European nonprofits. Modular monolith, GDPR-native, Salesforce alternative.

**Givernance** is a purpose-built CRM for European nonprofits (2-200 staff), replacing Salesforce NPSP with GDPR-native compliance, affordable pricing, and an AI-augmented dual-mode interface.

**Marketing website**: [givernance.org](https://givernance.org)

## Getting Started

```bash
# Clone the repository
git clone git@github.com:Onigam/givernance.git
cd givernance

# Node.js 22 LTS + pnpm 9 required
pnpm install

# Copy env file and start infra (PostgreSQL, Redis, Keycloak, MinIO, Mailpit)
cp .env.example .env
./scripts/dev-up.sh

# Migrate + seed the demo tenant (50 constituents, 5 campaigns, 100 donations)
pnpm db:migrate
pnpm --filter @givernance/api run db:seed

# Start all dev servers (web :3000, api :4000, worker, relay)
pnpm dev
```

Then browse to `http://localhost:3000`, log in with `admin@givernance.org` / `admin`.

**Full local dev guide**: [docs/infra/README.md](docs/infra/README.md) — includes SSO shim notes, troubleshooting, and tooling recommendations.

### Browse the mockups

```bash
open docs/design/index.html
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| API | TypeScript (Node.js 22 LTS), Fastify 5, modular monolith |
| Worker | TypeScript, BullMQ 5 (Redis-backed) |
| Web | Next.js 16 (React, TypeScript) |
| Database | PostgreSQL 16 + Drizzle ORM |
| Job Queue | BullMQ 5 (Redis) — NATS JetStream deferred to Phase 4+ |
| Auth | Keycloak (OIDC) |
| Infra | Docker, pnpm workspaces monorepo |

### Monorepo Structure

The backend is organized as a pnpm workspaces monorepo:

```
packages/
├── shared/    — Drizzle schema, Zod validators, shared types, domain events
├── api/       — Fastify 5 API server (all domain modules)
├── worker/    — BullMQ job processor
└── migrate/   — One-off Salesforce ETL tool
```

The design system reference is at `docs/design/design-system.html`. All 86 interactive mockups are in `docs/design/`.

## Design Mockups

86 interactive HTML mockups across 17 modules, viewable on GitHub Pages:

**[View the mockups](https://onigam.github.io/givernance/design/)**

- **75 classic GUI screens**: Auth, Dashboard, Constituents, Donations, Campaigns, Grants, Programs, Volunteers, Impact, Communications, Finance, GDPR, Admin, Reports, Migration, Global
- **11 Conversational Mode screens** (vision 2026-2028): AI hub, action orchestration, hybrid view, mobile, enhanced dashboard — [view the conversational mockups](https://onigam.github.io/givernance/design/conversational-mode/index.html)

### Dual-mode vision

Givernance offers two complementary interaction paradigms:

1. **AI-augmented GUI** — Classic interface enriched with inline AI suggestions (3 modes: Manual, Assisted, Autopilot)
2. **Conversational mode** (vision) — Natural-language AI agent, action orchestration, invocable components

See [docs/vision/conversational-mode.md](docs/vision/conversational-mode.md) for the detailed architecture.

## Documentation

### Architecture & Specs
- [docs/01-product-scope.md](docs/01-product-scope.md)
- [docs/02-reference-architecture.md](docs/02-reference-architecture.md)
- [docs/03-data-model.md](docs/03-data-model.md)
- [docs/04-business-capabilities.md](docs/04-business-capabilities.md)
- [docs/05-integration-migration.md](docs/05-integration-migration.md)
- [docs/06-security-compliance.md](docs/06-security-compliance.md)
- [docs/07-delivery-roadmap.md](docs/07-delivery-roadmap.md)
- [docs/08-pricing-packaging.md](docs/08-pricing-packaging.md)
- [docs/09-risk-register.md](docs/09-risk-register.md)
- [docs/10-open-questions.md](docs/10-open-questions.md)

### Design & UX
- [docs/11-design-identity.md](docs/11-design-identity.md) — Visual identity, tokens, components, accessibility
- [docs/12-user-journeys.md](docs/12-user-journeys.md) — User journeys (5 personas)
- [docs/13-ai-modes.md](docs/13-ai-modes.md) — Three AI interaction modes (Manual, Assisted, Autopilot)
- [docs/14-screen-inventory.md](docs/14-screen-inventory.md) — Complete inventory of the 86 screens
- [docs/vision/conversational-mode.md](docs/vision/conversational-mode.md) — Conversational mode vision 2026-2028

## Diagrams
- diagrams/context.mmd
- diagrams/container.mmd
- diagrams/core-erd.mmd
- diagrams/migration-flow.mmd

## Specialized Agents

16 Claude agents for domain-specific tasks (see `.claude/agents/`):

- `.claude/agents/domain-analyst.md` — Business domain analysis and bounded contexts
- `.claude/agents/data-architect.md` — Data model design and database architecture
- `.claude/agents/platform-architect.md` — System architecture and infrastructure decisions
- `.claude/agents/migration-architect.md` — Salesforce-to-Givernance migration strategy
- `.claude/agents/security-architect.md` — Security, compliance, and GDPR controls
- `.claude/agents/pricing-strategist.md` — Pricing model and packaging strategy
- `.claude/agents/ux-researcher.md` — User research, personas, and usability validation
- `.claude/agents/design-architect.md` — Visual identity, design system, and UI/UX principles
- `.claude/agents/mvp-engineer.md` — Full-stack implementation (Fastify routes, Drizzle ORM, BullMQ jobs)
- `.claude/agents/api-contract-designer.md` — REST API contracts, TypeBox schemas, OpenAPI 3.1, RFC 9457 errors
- `.claude/agents/qa-engineer.md` — Integration tests, RLS isolation, GDPR compliance, Stripe webhooks
- `.claude/agents/log-analyst.md` — Structured logging, distributed tracing, audit trail, performance diagnostics
- `.claude/agents/feature-flag-engineer.md` — Feature flag schema, evaluation, lifecycle, plan-gating
- `.claude/agents/impersonation-engineer.md` — Impersonation token design, session lifecycle, double-attribution audit
- `.claude/agents/payment-engineer.md` — Stripe Connect, Mollie, SEPA DD, webhooks, PCI DSS SAQ A, reconciliation
- `.claude/agents/translation-specialist.md` — Translation completeness, terminology consistency, locale QA
