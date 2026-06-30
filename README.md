# Givernance

<img src="docs/design/shared/assets/givernance-logo.svg" alt="Givernance" width="240">

> **The operational layer European nonprofits use to run fundraising, donor stewardship, grants and reporting — in one place.**

Givernance is a purpose-built, GDPR-native CRM for European nonprofits (2–200 staff) — an affordable, EU-hosted alternative to Salesforce NPSP. It is a multi-tenant SaaS built as a TypeScript modular monolith, with an AI-augmented interface and a roadmap toward a conversational mode.

**Marketing website**: [givernance.org](https://givernance.org)

---

## What, who, and why

- **What** — A constituent & fundraising platform: donations, pledges, recurring giving, campaigns, grants, programs/beneficiaries, volunteer coordination, impact reporting, and GDPR compliance tooling — centred on the donor lifecycle (`Prospect → First Gift → Recurring → Major → Lapsed → Re-engaged`).
- **Who** — Small-to-medium European NPOs (2–200 staff) who find Salesforce NPSP too expensive (€75+/seat past 10 seats), too US-centric (USD, US receipts), and too admin-heavy to run without a dedicated Salesforce specialist.
- **Why** — GDPR is native, not retrofitted (right-to-erasure, audit trail, EU data residency, consent). Pricing is affordable. The data model is EU-first (EUR, SEPA, Swiss QR-bill, EU tax receipts). Your data is yours — open formats, no proprietary lock-in.

See [docs/01-product-scope.md](docs/01-product-scope.md) for the full problem statement, personas, and MoSCoW scope.

## Project status

**Phase 1 — Donor Management MVP, shipping to staging.** Givernance is an actively-developed multi-tenant SaaS, not a planning-stage project. The pnpm monorepo has six working packages — a Fastify + Drizzle **api** (25 domain modules: constituents, donations, pledges, campaigns, funds, payments/Stripe, bank-accounts, disputes, finance/GL reports, notifications, search, branding, multi-tenant admin/superadmin, …), a **Next.js 16 / React 19 web** app, plus **worker**, **relay** (transactional-outbox → BullMQ), **shared**, and **migrate**. The schema spans 86 Drizzle migrations. Code deploys via Kamal to a live **staging** environment (`staging.givernance.org`, Scaleway EU VPS); a production launch runbook is prepared ([docs/runbooks/launch-prod.md](docs/runbooks/launch-prod.md)).

Roadmap and phase gates: [docs/07-delivery-roadmap.md](docs/07-delivery-roadmap.md).

## Tech stack

| Layer | Technology |
|-------|-----------|
| API | TypeScript (Node.js 22 LTS), Fastify 5, modular monolith |
| Worker | TypeScript, BullMQ 5 (Redis-backed) |
| Relay | Transactional-outbox poller → BullMQ (`SELECT … FOR UPDATE SKIP LOCKED`) |
| Web | Next.js 16, React 19, Tailwind 4, Radix UI, TanStack Query/Table, next-intl |
| Database | PostgreSQL 17 + Drizzle ORM (row-level security per tenant) |
| Job queue / events | BullMQ 5 + Redis — NATS JetStream deferred to Phase 4+ |
| Storage | Scaleway Object Storage EU (SaaS) · SeaweedFS (self-hosted / dev / staging) |
| Auth | Keycloak 26 (OIDC / SAML, Organizations = tenants) |
| Payments | Stripe Connect, Mollie, SEPA DD, Swiss QR-bill (BVR) + camt.053 |
| AI inference | Scaleway Generative APIs (Mistral, Llama) — EU-hosted, GDPR Art. 9 |
| Deployment | Kamal + Scaleway EU VMs (SaaS) · Docker Compose (self-hosted) |
| Infra | Docker, pnpm workspaces monorepo, single Scaleway GDPR DPA |

## Monorepo structure

```
packages/
├── shared/    — Drizzle schema, validators, shared types, domain events
├── api/       — Fastify 5 API server (25 domain modules)
├── worker/    — BullMQ background job processor
├── relay/     — Transactional-outbox relay → BullMQ
├── web/       — Next.js 16 web app (operator + donor surfaces)
└── migrate/   — One-off Salesforce ETL tool
```

## Getting started

### Prerequisites

- **Node.js 22 LTS**
- **pnpm 10** (`corepack enable` picks up the version pinned in `package.json` → `packageManager`)
- **Docker** (for the local infra stack: PostgreSQL, Redis, Keycloak, SeaweedFS, Mailpit)

### Quickstart

```bash
# Clone
git clone git@github.com:purposestack/givernance.git
cd givernance

# Install dependencies
pnpm install

# Activate the pre-push CI guard (one-shot, see "Contributing")
git config core.hooksPath .githooks

# Start the local infra stack (copies .env from .env.example on first run)
pnpm dev:up

# Migrate + seed the demo tenant (constituents, campaigns, donations)
pnpm db:migrate
pnpm --filter @givernance/api run db:seed

# Start all dev servers (web :3000, api :4000, worker, relay)
pnpm dev
```

Then browse to `http://localhost:3000` and log in with `admin@givernance.org` / `admin`.

**Full local dev guide**: [docs/infra/README.md](docs/infra/README.md) — infra stack, SSO/Keycloak notes, secrets, troubleshooting, and tooling.

### Common commands

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Run all dev servers in parallel (web, api, worker, relay) |
| `pnpm dev:up` / `pnpm dev:down` | Start / stop the local Docker infra stack |
| `pnpm build` | Build every package |
| `pnpm typecheck` | TypeScript strict check across the workspace |
| `pnpm test` | Run the integration test suites |
| `pnpm db:migrate` | Apply Drizzle migrations |
| `pnpm db:generate` | Generate a migration from a schema diff |
| `pnpm --filter @givernance/api run db:seed` | Seed the demo tenant |
| `pnpm biome check .` | Lint + format check — **the exact gate CI runs** |
| `pnpm biome check --write .` | Auto-fix lint + format |

## Design mockups

Interactive HTML mockups (operator + donor + roadmap surfaces) live in [`docs/design/`](docs/design/). Open the index locally:

```bash
open docs/design/index.html
```

- Classic GUI screens across Auth, Dashboard, Constituents, Donations, Campaigns, Grants, Programs, Volunteers, Impact, Communications, Finance, GDPR, Admin, Reports, Migration, Global.
- Conversational-mode screens (vision 2026–2028): AI hub, action orchestration, hybrid view, mobile.

The design-system reference is at [`docs/design/design-system.html`](docs/design/design-system.html). Per the **Mockup-First Rule** in [CLAUDE.md](CLAUDE.md), every UI implementation must match its mockup.

### Dual-mode vision

1. **AI-augmented GUI** — Classic interface enriched with inline AI suggestions (3 modes: Manual, Assisted, Autopilot — [docs/13-ai-modes.md](docs/13-ai-modes.md)).
2. **Conversational mode** (vision) — Natural-language agent, action orchestration, invocable components — [docs/vision/conversational-mode.md](docs/vision/conversational-mode.md).

## Documentation

All specs live in [`docs/`](docs/), numbered `01`–`34` for architecture/domain specs.

### Architecture & specs
- [01 — Product scope](docs/01-product-scope.md) · [02 — Reference architecture](docs/02-reference-architecture.md) · [03 — Data model](docs/03-data-model.md) · [04 — Business capabilities](docs/04-business-capabilities.md)
- [05 — Integration & migration](docs/05-integration-migration.md) · [06 — Security & compliance](docs/06-security-compliance.md) · [07 — Delivery roadmap](docs/07-delivery-roadmap.md)
- [08 — Pricing & packaging](docs/08-pricing-packaging.md) · [09 — Risk register](docs/09-risk-register.md) · [10 — Open questions](docs/10-open-questions.md)
- [15 — Infra ADRs](docs/15-infra-adr.md) · [16 — Field insights](docs/16-greg-field-insights.md) · [17 — Log management](docs/17-log-management.md) · [18 — Feature flags](docs/18-feature-flags.md) · [19 — Impersonation](docs/19-impersonation.md)

### Domain feature specs
- [21 — Authentication & SSO](docs/21-authentication-sso.md) · [22 — Tenant onboarding](docs/22-tenant-onboarding.md) · [23 — Postal campaigns](docs/23-postal-campaigns.md) · [24 — Branding assets](docs/24-branding-assets.md)
- [25 — Swiss QR-bill + camt.053](docs/25-swiss-qr-bill.md) · [26 — Public page styles](docs/26-public-page-styles.md) · [27 — Notifications](docs/27-notifications.md) · [28 — Bulk import](docs/28-bulk-import.md)
- [29 — Global search](docs/29-global-search.md) · [30 — Advanced filters](docs/30-advanced-filters.md) · [31 — Mobilization score](docs/31-tenant-mobilization-score.md) · [32 — Survey infrastructure](docs/32-survey-infrastructure.md)
- [33 — Platform finance reports](docs/33-platform-finance-reports.md) · [34 — Constituents & multi-valued type](docs/34-constituents.md)

### Developer references
- [DONOR_MVP.md](docs/DONOR_MVP.md) — Donor-management MVP implementation guide (Phase 1 quick reference)
- [glossary-npo.md](docs/glossary-npo.md) — NPO domain glossary · [glossary-i18n.md](docs/glossary-i18n.md) — FR/EN translation reference

### Design & UX
- [11 — Design identity](docs/11-design-identity.md) — Visual identity, tokens, components, accessibility
- [12 — User journeys](docs/12-user-journeys.md) — 5 persona journeys
- [13 — AI modes](docs/13-ai-modes.md) — Manual / Assisted / Autopilot
- [14 — Screen inventory](docs/14-screen-inventory.md) — Complete screen inventory

### Security & compliance
- [06 — Security & compliance](docs/06-security-compliance.md) — GDPR, RBAC, encryption, audit
- [docs/security/](docs/security/) — Periodic security audits & route-by-route RBAC matrices (e.g. [rbac-audit-2026-04-27.md](docs/security/rbac-audit-2026-04-27.md))

### Payments
- [Payments overview](docs/payments-overview.md) — Money-flow primer: how fees are collected, why each NPO connects rather than pasting keys
- [20 — Payment strategy](docs/20-payment-strategy.md) — Stripe/Mollie/Mangopay comparison, ADR-010, PCI DSS, GDPR
- [25 — Swiss QR-bill](docs/25-swiss-qr-bill.md) — BVR generation + camt.053 reconciliation

### Operations
- [ADRs — docs/adrs/](docs/adrs/) — 32 Architecture Decision Records (bucket topology, image pipeline, Swiss QR-bill, camt.053 ingestion, Keycloak session revocation, …)
- [Runbooks — docs/runbooks/](docs/runbooks/) — Operator one-shot procedures, incl. [launch-prod.md](docs/runbooks/launch-prod.md), [feature-flag-rollback.md](docs/runbooks/feature-flag-rollback.md)
- [Local development — docs/dev/](docs/dev/) — incl. [Stripe Connect local setup](docs/dev/stripe-local-setup.md) and [staging secrets setup](docs/dev/staging-secrets-setup.md)
- [Infra — docs/infra/README.md](docs/infra/README.md) — Local stack, databases topology, Compose services

## Diagrams

C4 + flow diagrams in [`diagrams/`](diagrams/) (Mermaid `.mmd`):

- [context.mmd](diagrams/context.mmd) · [container.mmd](diagrams/container.mmd) · [core-erd.mmd](diagrams/core-erd.mmd) · [migration-flow.mmd](diagrams/migration-flow.mmd)
- Flow companions: [postal-campaign](diagrams/postal-campaign-flow.mmd) · [branding-upload](diagrams/branding-upload-flow.mmd) · [swiss-qr-bill](diagrams/swiss-qr-bill-flow.mmd) · [camt053-reconciliation](diagrams/camt053-reconciliation-flow.mmd) · [public-page-styles](diagrams/public-page-styles-flow.mmd) · [notifications](diagrams/notifications-flow.mmd) · [bulk-import](diagrams/bulk-import-flow.mmd)

## Specialized agents

16 Claude agents for domain-specific tasks live in [`.claude/agents/`](.claude/agents/):

| Agent | Purpose |
|-------|---------|
| `domain-analyst` | Business domain analysis and bounded contexts |
| `data-architect` | Data model design and database architecture |
| `platform-architect` | System architecture and infrastructure decisions |
| `migration-architect` | Salesforce-to-Givernance migration strategy |
| `security-architect` | Security, compliance, and GDPR controls |
| `pricing-strategist` | Pricing model and packaging strategy |
| `ux-researcher` | User research, personas, and usability validation |
| `design-architect` | Visual identity, design system, and UI/UX principles |
| `mvp-engineer` | Full-stack implementation (Fastify routes, Drizzle ORM, BullMQ jobs) |
| `api-contract-designer` | REST API contracts, TypeBox schemas, OpenAPI 3.1, RFC 9457 errors |
| `qa-engineer` | Integration tests, RLS isolation, GDPR compliance, Stripe webhooks |
| `log-analyst` | Structured logging, distributed tracing, audit trail, performance |
| `feature-flag-engineer` | Feature flag schema, evaluation, lifecycle, plan-gating |
| `impersonation-engineer` | Impersonation token design, session lifecycle, double-attribution audit |
| `payment-engineer` | Stripe Connect, Mollie, SEPA DD, webhooks, PCI DSS SAQ A, reconciliation |
| `translation-specialist` | Translation completeness, terminology consistency, locale QA |

## Contributing

Engineering conventions, architectural rules (RLS, feature flags, bucket topology, migrations journal, …), and the agent workflow are documented in [CLAUDE.md](CLAUDE.md). Read it before opening a PR.

**Before every push**, CI runs `pnpm biome check .` as the load-bearing gate. Install the repo-tracked pre-push hook once per clone so a failing check can't reach CI:

```bash
git config core.hooksPath .githooks
```

The full pre-push checklist: `pnpm install` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm biome check .` (auto-fix with `pnpm biome check --write .`).

Conventions worth knowing up front:
- Product name is **Givernance**; the entity term is **NPO** (not "NGO").
- Every new user-facing feature ships **behind a default-off feature flag** ([docs/18-feature-flags.md](docs/18-feature-flags.md)).
- Every tenant-scoped query filters by `orgId` explicitly — RLS is the safety net, never the contract.
- Every domain change updates its `docs/NN-*.md` spec in the same PR.
