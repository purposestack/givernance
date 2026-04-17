# 07 — Delivery Roadmap

## Implementation Start Checklist

Before writing Phase 1 code, verify:
- [ ] Phase 0 acceptance gates passed (auth scaffold, RLS middleware, CI/CD green)
- [ ] Drizzle schema baseline committed (`packages/shared/src/schema/`)
- [ ] At least one integration test passes (`GET /healthz`)
- [ ] Local dev environment boots cleanly (`docker-compose up`)
- [ ] Scaleway Managed PostgreSQL EU instance provisioned (for SaaS target) OR local Postgres running
- [ ] GitHub issues for Sprint 1 assigned and labeled `priority:1`

## Phase 0 (4 weeks): Foundation
- Auth, org model, RBAC, audit trail
- Core data model skeleton
- TypeScript monorepo scaffolding (pnpm workspaces, tsconfig, Drizzle schema baseline)
- CI/CD + infra baseline
- **Infra (SaaS)**: Scaleway Managed PostgreSQL EU, Scaleway Managed Redis EU, Scaleway Object Storage EU — all under single Scaleway GDPR DPA (~67€/month). Observability via Scaleway Cockpit (Grafana + Loki + Mimir + Tempo, free for Scaleway-native data). See [ADR-009](./15-infra-adr.md#adr-009--scaleway-as-primary-saas-managed-cloud-provider).
- **Infra (self-hosted)**: Docker Compose (Postgres 16, Redis 7, MinIO, Keycloak, Caddy)
- **Event bus**: BullMQ + Redis via transactional outbox — NATS deferred to Phase 4 (see ADR-005)

## Phase 1 (8 weeks): Fundraising Core — Donor Management MVP

> **Infra (SaaS) cost estimate**: ~281€/month for 1 NPO pilot (API × 2, Worker, Web, PostgreSQL + replica, Redis, Keycloak HA, Cockpit, Load Balancer). Budget alternative with Keycloak co-located on API VM: ~180€/month. Phase 1 extended (5–10 NPOs): ~458€/month. All on Scaleway EU — see [ADR-009](./15-infra-adr.md#adr-009--scaleway-as-primary-saas-managed-cloud-provider).

> **This is the MVP phase.** An NPO completing Phase 1 can replace Salesforce NPSP for their core fundraising operations.
> Flagship domain: donor management. Sequence is strict — each sprint depends on the previous.

### Sprint 1 (Weeks 1–2): Constituent Foundation
The data model foundation. Every other module references constituents.

- Constituents API: CRUD for individuals, households, organizations (issue #32)
- Constituent duplicate detection — fuzzy match on name+email (issue #33)
- Multi-tenant RLS applied to constituents table (prerequisite from Phase 0: issue #31)

**Done when**: `GET /v1/constituents`, `POST /v1/constituents`, `GET /v1/constituents/:id`, `PUT`, `DELETE` all pass integration tests with RLS tenant isolation verified.

### Sprint 2 (Weeks 2–4): Donation Engine + Postal Campaign Core
The core transaction and the primary fundraising channel. Postal campaigns represent ~60% of NPO donations — this is CORE MVP, not optional.

- Donations API: one-time gifts, pledges, installments, fund allocation (issue #34)
- SEPA/Stripe integration for recurring donations (issue #38)
- PDF receipt generation — EU tax receipt format, country-specific (issue #35)
- BullMQ job: receipt generation triggered on donation.created event
- **QR code generation**: unique QR per constituent+campaign, stored in `campaign_documents` table (issue #36)
- **PDF letter generation**: personalized letters per constituent (name, address, donation history), batch PDF generation for print-ready output
- **Door-drop support**: generic letter variant for geographic zone targeting (QR linked to campaign only, no constituent); new constituent created on first donation receipt

**Done when**: A donation can be recorded, triggers a BullMQ job, generates a PDF receipt stored in R2/MinIO, and the constituent's donation history is updated. A campaign can generate batch PDFs with individual QR codes for all selected constituents. A door-drop campaign can target a zone and generate generic letters.

### Sprint 3 (Weeks 4–6): Campaigns + Donor Lifecycle + Online Donations
Grouping mechanism, reporting foundation, and the second fundraising channel (~20% of donations).

- Campaigns API + source code tracking (issue #37)
- Campaign types: nominative postal, door-drop, digital — each with distinct workflow
- Donor lifecycle calculation: LYBUNT/SYBUNT flags (issue #37)
- Donations linked to campaigns; campaign totals computed
- **Campaign ROI dashboard**: cost vs. donations received per campaign, conversion rates, response monitoring (3-month tracking window for postal)
- **Stripe Connect onboarding**: NPO connects their own Stripe account via OAuth — Givernance never holds funds, no PSP status required
- **Public donation page**: embeddable widget/form per campaign, activatable and shareable URL, inherits host site styling when embedded
- **Stripe webhook handler**: `POST /v1/donations/stripe-webhook` — auto-creates donation record, matches to campaign, creates constituent if new

**Done when**: A campaign has a total raised figure with ROI metrics. A constituent can be identified as LYBUNT. An NPO can connect Stripe, activate a public donation page, and receive online donations that auto-reconcile to campaign totals.

### Sprint 4 (Weeks 5–7): UI Layer
Frontend implementation of Sprints 1–3.

- Constituents UI: list, detail, create, import CSV (issue #41)
- Donations UI: list, new donation form, receipt preview (issue #41)
- Dashboard UI: key widgets — total raised, active campaigns, grant deadlines (issue #42)
- Auth UI: SSO-only login page + back-office tenant provisioning (Spike [#80](https://github.com/purposestack/givernance/issues/80), issue #40). The former "5-step onboarding wizard" has been dropped — tenants are created by a Givernance Super Admin and user accounts are provisioned Just-In-Time on first SSO login (see `docs/21-authentication-sso.md` §2).

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
- Postal campaign workflow end-to-end: create campaign → select constituents → generate QR+PDF batch → monitor incoming donations with auto-matching
- Online donation workflow end-to-end: Stripe Connect onboarded → public page active → donation received → webhook creates record → campaign total updated
- Campaign ROI dashboard shows cost vs. revenue for at least one postal and one digital campaign
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
