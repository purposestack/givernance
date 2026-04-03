# Givernance Constitution
<!-- Constitution Version: 1.0.0 | Ratified: 2026-04-03 | Last Amended: 2026-04-03 -->

## Preamble

Givernance is a purpose-built CRM for European nonprofits (2–200 staff), designed as a GDPR-native, affordable alternative to Salesforce NPSP. This constitution distills the governing principles established during Phase 0 (Foundation). All specifications, implementations, and architectural decisions must align with these principles.

---

## Core Principles

### I. Donor-First Product Logic

The central relationship in a nonprofit is between the organization and its donors. The Constituent + Donation modules ship first, fully tested, before any other domain. Every other module (programs, grants, volunteers, impact) enriches the donor picture but does not replace it.

**Non-negotiable rules:**
- Constituent and Donation modules are always Phase 1 — no exceptions
- The donor lifecycle (Prospect → First Gift → Recurring → Major → Lapsed → Re-engaged) is the backbone of the data model
- Features that do not serve or enrich the donor relationship are deferred

### II. GDPR-Native, Not GDPR-Retrofitted

GDPR compliance is baked into every layer — it is not a compliance checkbox applied after the fact. The platform is designed for European nonprofits under GDPR Art. 9 (sensitive beneficiary data).

**Non-negotiable rules:**
- Data residency: all SaaS data stored in Scaleway EU infrastructure; no US data transfers
- Right-to-erasure, audit logs, consent management, and data minimization are first-class features
- AI inference for sensitive beneficiary data uses only Scaleway Generative APIs (EU-based, GDPR DPA)
- A single Scaleway GDPR DPA covers all SaaS infrastructure
- Every feature spec must include a GDPR section

### III. Modular Monolith First

The architecture is a modular monolith — not microservices. Each domain module (CRM, Donations, Grants, Programs, Volunteers) is isolated by bounded context within a single deployable unit.

**Non-negotiable rules:**
- Domain modules communicate via typed domain events, never direct cross-module DB queries
- No distributed system complexity before Phase 4+ (NATS JetStream added only then)
- BullMQ + Redis for async jobs in Phases 0–3
- Microservices extraction is a deliberate future option, not a starting assumption

### IV. Dual Deployment, Single Codebase

Givernance ships as both SaaS (Scaleway EU) and self-hosted (Docker Compose). Both deployment modes run the same codebase.

**Non-negotiable rules:**
- SaaS: Scaleway Managed PostgreSQL, Redis, Object Storage, Cockpit (Grafana/Loki/Mimir/Tempo)
- Self-hosted: Docker Compose with PostgreSQL 16 + PgBouncer, Redis 7, MinIO
- No feature may be SaaS-only unless it is a managed infrastructure concern
- Deployment parity is tested in CI

### V. AI-Augmented, Human-Confirmed

Givernance uses AI agents inside core workflows to reduce clicks and admin burden — without removing human control. The platform offers three AI modes: Manual, Assisted, Autopilot.

**Non-negotiable rules:**
- AI proposes; human confirms for all sensitive operations (finance, compliance, beneficiary status)
- Every AI suggestion must include explainability ("why" + source fields)
- No irreversible action without explicit user confirmation
- Full auditability of all AI actions, prompts, and outputs
- Sensitive beneficiary data never leaves EU infrastructure for AI processing

### VI. TypeScript End-to-End

The entire stack is TypeScript — API, worker, web, shared schemas, and migration tools. Shared types are the contract between layers.

**Non-negotiable rules:**
- API: Node.js 22 LTS, Fastify 5, TypeBox schemas
- Web: Next.js 15 (React, TypeScript)
- Database: PostgreSQL 16 + Drizzle ORM with UUIDv7 primary keys
- Shared: `packages/shared` owns Drizzle schema, Zod validators, shared types, domain events
- No runtime type mismatches — Zod validates at all trust boundaries

### VII. Spec Before Code

No feature is implemented without a specification. The Spec Kit workflow (Constitution → Spec → Clarify → Plan → Tasks → Implement) is the mandatory path for all new features from Phase 1 onward.

**Non-negotiable rules:**
- Every feature starts with a spec in `.specify/specs/`
- Implementation only begins after spec is reviewed and tasks are defined
- The spec is the source of truth — code must match it, not the other way around
- Open questions are tracked in `docs/10-open-questions.md` until resolved

### VIII. Nonprofit-Specific, Not Generic

Givernance is built for European nonprofits. It is not a generic CRM with nonprofit features bolted on. EU-specific concerns (EUR, EU charity law, GDPR, EU tax receipts, SEPA) are first-class.

**Non-negotiable rules:**
- Terminology: NPO (not NGO), constituent (not contact/lead), campaign (nonprofit sense)
- Currency: EUR as default; multi-currency is a future concern, not Phase 1
- Payment: SEPA Direct Debit is a first-class payment method alongside Stripe
- Pricing model: affordable for 2–200 staff orgs; no per-module licensing trap

---

## Technology Decisions (Non-Negotiable)

| Concern | Decision | Rationale |
|---|---|---|
| Primary language | TypeScript everywhere | End-to-end type safety |
| API framework | Fastify 5 | Performance, TypeBox native integration |
| ORM | Drizzle ORM | Type-safe, Postgres-native, no magic |
| Primary keys | UUIDv7 (`uuid_generate_v7()`) | Time-sortable, collision-safe |
| Auth | Keycloak 24 (OIDC/SAML) | Enterprise SSO, self-hosted on Scaleway |
| SaaS cloud | Scaleway EU | GDPR DPA, EU data residency |
| AI inference | Scaleway Generative APIs | GDPR Art. 9 compliance for beneficiary data |
| Package manager | pnpm workspaces | Monorepo efficiency |
| Audit log table | `audit_log` (singular) | Established convention — never `audit_logs` |

---

## Governance

### Amendment Procedure
1. Open a GitHub issue describing the proposed change and rationale
2. Discussion period: minimum 2 working days for non-urgent changes
3. Amendment approved by project lead (suikipik)
4. Update this file, increment version, set `Last Amended` date
5. All open specs must be reviewed for alignment within 1 sprint

### Versioning Policy
- **MAJOR**: Backward-incompatible governance change (principle removal or redefinition)
- **MINOR**: New principle added or materially expanded
- **PATCH**: Clarification, wording fix, typo

### Compliance Review
- Every new spec must reference the relevant principles from this constitution
- Architecture Decision Records (ADRs) must cite which principles they uphold
- Quarterly review of open questions (`docs/10-open-questions.md`) against constitution

---

*Constitution v1.0.0 — Distilled from Phase 0 analysis (docs/01–20) — Givernance, April 2026*
