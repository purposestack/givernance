# 07 — Delivery Roadmap

## Implementation Start Checklist

Before writing Phase 1 code, verify:
- [ ] Phase 0 acceptance gates passed (auth scaffold, RLS middleware, CI/CD green)
- [ ] Drizzle schema baseline committed (`packages/shared/src/schema/`)
- [ ] At least one integration test passes (`GET /healthz`)
- [ ] Local dev environment boots cleanly (`docker-compose up`)
- [ ] Neon.tech EU project provisioned (for SaaS target) OR local Postgres running
- [ ] GitHub issues for Sprint 1 assigned and labeled `priority:1`

## Phase 0 (4 weeks): Foundation
- Auth, org model, RBAC, audit trail
- Core data model skeleton
- TypeScript monorepo scaffolding (pnpm workspaces, tsconfig, Drizzle schema baseline)
- CI/CD + infra baseline
- **Infra (SaaS)**: Neon.tech EU (PostgreSQL managed), Upstash Redis EU (serverless), Cloudflare R2 (storage)
- **Infra (self-hosted)**: Docker Compose (Postgres 16, Redis 7, MinIO, Keycloak, Caddy)
- **Event bus**: BullMQ + Redis via transactional outbox — NATS deferred to Phase 4 (see ADR-005)

## Phase 1 (8 weeks): Fundraising Core — Donor Management MVP

> **This is the MVP phase.** An NPO completing Phase 1 can replace Salesforce NPSP for their core fundraising operations.
> Flagship domain: donor management. Sequence is strict — each sprint depends on the previous.

### Sprint 1 (Weeks 1–2): Constituent Foundation
The data model foundation. Every other module references constituents.

- Constituents API: CRUD for individuals, households, organizations (issue #9)
- Constituent duplicate detection — fuzzy match on name+email (issue #11)
- Multi-tenant RLS applied to constituents table (prerequisite from Phase 0: issue #12)

**Done when**: `GET /v1/constituents`, `POST /v1/constituents`, `GET /v1/constituents/:id`, `PUT`, `DELETE` all pass integration tests with RLS tenant isolation verified.

### Sprint 2 (Weeks 2–4): Donation Engine
The core transaction. This is what generates revenue for NPOs.

- Donations API: one-time gifts, pledges, installments, fund allocation (issue #13)
- SEPA/Stripe integration for recurring donations (issue #15)
- PDF receipt generation — EU tax receipt format, country-specific (issue #17)
- BullMQ job: receipt generation triggered on donation.created event

**Done when**: A donation can be recorded, triggers a BullMQ job, generates a PDF receipt stored in R2/MinIO, and the constituent's donation history is updated.

### Sprint 3 (Weeks 4–5): Campaigns + Donor Lifecycle
Grouping mechanism + reporting foundation.

- Campaigns API + source code tracking (issue #19)
- Donor lifecycle calculation: LYBUNT/SYBUNT flags (issue #21)
- Donations linked to campaigns; campaign totals computed

**Done when**: A campaign has a total raised figure. A constituent can be identified as LYBUNT.

### Sprint 4 (Weeks 5–7): UI Layer
Frontend implementation of Sprints 1–3.

- Constituents UI: list, detail, create, import CSV (issue #29)
- Donations UI: list, new donation form, receipt preview (issue #31)
- Dashboard UI: key widgets — total raised, active campaigns, grant deadlines (issue #32)
- Auth UI: login, SSO, onboarding wizard 5 steps (issue #33)

**Done when**: A non-technical NPO staff member can log in, find a donor, record a gift, and see the receipt — without reading any documentation.

### Sprint 5 (Weeks 7–8): Compliance + Handoff
GDPR and finance integration to close the MVP.

- GDPR consent log per constituent + SAR workflow (issue #27)
- GL export — fund-to-nominal-code mapping + batch closing (issue #23)
- Bulk email via Resend/Brevo + suppression management (issue #25)

**Done when**: MVP acceptance criteria in docs/01-product-scope.md §7 are all satisfied.

---

**Phase 1 acceptance gates:**
- All MVP criteria from docs/01-product-scope.md §7 satisfied
- Constituent + donation integration tests: >90% coverage on happy path
- PDF receipt generated end-to-end (donation → BullMQ job → PDF → stored → URL returned)
- LYBUNT report returns correct results on seeded test data
- One pilot NPO onboarded and using it for real donations

## Phase 2 (8 weeks): Program & Case
- Programs, beneficiaries, enrollments
- Case notes, service delivery
- Impact indicators v1

## Phase 3 (6 weeks): Grants & Volunteer
- Grant pipeline, deliverables, reports
- Volunteer opportunities, shifts, hours

## Phase 4 (6 weeks): Migration & Hardening
- Salesforce migration toolkit
- Performance hardening, observability
- Security review + GDPR controls completion
- **Introduce NATS JetStream**: domain event fan-out, multi-subscriber consumers, outbound webhook scaling
- Migrate outbox publisher from BullMQ-direct to NATS; BullMQ retained for scheduled/periodic tasks
- NATS stream topology: `constituent.events`, `donation.events`, `program.events`, `comms.events`

## Acceptance gates
- < 2 weeks onboarding for pilot org
- 95%+ migration field mapping coverage for pilot NPSP org
- Monthly close export reproducible with audit trail


## Parallel stream: AI UX Research (all phases)
- Phase 0: define AI interaction principles + safety constraints
- Phase 1: test AI copilots for fundraising workflows
- Phase 2: test AI copilots for case/program workflows
- Phase 3: test AI copilots for grants/volunteer workflows
- Phase 4: harden governance, telemetry, and model fallback strategy

Deliverable each phase: validated UX findings + go/no-go for AI feature rollout.

## Future: Mode Conversationnel (2026-2028)

Vision prospective : évolution vers un paradigme dual-mode (GUI + Agent conversationnel).

- Phase 5a (2026 H2): Palette de commandes augmentée + Dashboard enrichi par copilote IA
- Phase 5b (2027): Hub conversationnel complet, résultats inline, orchestration d'actions, vue hybride
- Phase 5c (2027-2028): Permissions agent, onboarding conversationnel, interface mobile-first, insights proactifs

Voir [docs/vision/conversational-mode.md](./vision/conversational-mode.md) pour l'architecture détaillée et les mockups de référence.
