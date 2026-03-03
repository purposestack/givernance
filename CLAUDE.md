# Givernance — CLAUDE.md

Givernance is a purpose-built CRM for European nonprofits (2-200 staff), designed as a GDPR-native, affordable alternative to Salesforce NPSP. The project is currently in Phase 0 (Foundation / Architecture Blueprint) — no production code yet, only design documents, mockups, and architecture specs.

## Tech Stack (Target)

| Layer | Technology |
|-------|-----------|
| API | Go 1.23, modular monolith |
| Web | Next.js 15 (React, TypeScript) |
| Database | PostgreSQL 16 |
| Messaging | NATS |
| Auth | Keycloak (OIDC) |
| Infra | Docker, Kubernetes |

## Directory Structure

```
├── CLAUDE.md              ← You are here
├── README.md              ← Project overview, getting started, doc index
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
│   ├── vision/
│   │   └── conversational-mode.md — Future conversational AI mode (2026-2028)
│   └── design/                    — 86 interactive HTML mockups
├── diagrams/
│   ├── context.mmd       — C4 system context
│   ├── container.mmd     — C4 container diagram
│   ├── core-erd.mmd      — Entity-relationship diagram
│   └── migration-flow.mmd — Salesforce migration flow
└── .claude/agents/        — 8 specialized Claude agents
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

## Implementation Status

**Phase 0 — Foundation (current)**: Architecture blueprint complete. 14 specification documents, 86 HTML mockups, 4 Mermaid diagrams. No production code yet.

Next: Phase 1 — Skeleton (project scaffolding, CI/CD, auth, first module).

## Design Mockups

HTML mockups are in `docs/design/`. Open `docs/design/index.html` locally or view on GitHub Pages: https://onigam.github.io/givernance/design/

## Conventions

- Project name: **Givernance** (not "Libero", not "givernance-npo-platform")
- Terminology: **NPO** (nonprofit organization), not "NGO"
- GDPR in English docs, RGPD in French docs
- All docs are in `docs/`, numbered 01-14 for architecture specs
