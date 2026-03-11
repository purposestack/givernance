# 07 — Delivery Roadmap

## Phase 0 (4 weeks): Foundation
- Auth, org model, RBAC, audit trail
- Core data model skeleton
- TypeScript monorepo scaffolding (pnpm workspaces, tsconfig, Drizzle schema baseline)
- CI/CD + infra baseline
- **Infra (SaaS)**: Neon.tech EU (PostgreSQL managed), Upstash Redis EU (serverless), Cloudflare R2 (storage)
- **Infra (self-hosted)**: Docker Compose (Postgres 16, Redis 7, MinIO, Keycloak, Caddy)
- **Event bus**: BullMQ + Redis via transactional outbox — NATS deferred to Phase 4 (see ADR-005)

## Phase 1 (8 weeks): Fundraising Core
- TypeScript Fastify API: Constituents/households/orgs
- Donations, pledges, campaigns, receipts
- Stripe/Mollie integration
- Basic finance handoff exports

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
