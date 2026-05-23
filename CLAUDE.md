# Givernance — CLAUDE.md

Givernance is a purpose-built CRM for European nonprofits (2-200 staff), designed as a GDPR-native, affordable alternative to Salesforce NPSP. The project is currently in Phase 0 (Foundation / Architecture Blueprint) — no production code yet, only design documents, mockups, and architecture specs.

## Tech Stack (Target)

| Layer | Technology |
|-------|-----------|
| API | TypeScript (Node.js 22 LTS), Fastify 5, modular monolith |
| Worker | TypeScript, BullMQ 5 (Redis-backed) |
| Web | Next.js 16 (React, TypeScript) |
| Database | PostgreSQL 17 + Drizzle ORM (SaaS: Scaleway Managed PostgreSQL EU · Self-hosted: Postgres 17 + PgBouncer) |
| Job Queue / Events | BullMQ 5 + Redis (Phase 0-3) — NATS JetStream added Phase 4+ |
| Cache / Rate-limit | Redis (SaaS: Scaleway Managed Redis EU · Self-hosted: Redis 8) |
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
│   ├── 23-postal-campaigns.md      — Postal campaigns + QR reconciliation (Epic #274): user flow, domain, readiness gates, attribution
│   ├── 24-branding-assets.md       — Organisation branding (Epic #286): logo upload, sharp variants, bucket topology, Keycloak sync, PDF embedding
│   ├── 25-swiss-qr-bill.md         — Swiss QR-bill (BVR) generation + camt.053 reconciliation (Epic #318): bank accounts, per-letter QRR/SCOR, ISO 20022 ingestion
│   ├── 26-public-page-styles.md    — Public donation page archetype catalogue (Epic #362): 10 archetypes, schema, three-layer resolution, picker UX, easter-egg policy
│   ├── 27-notifications.md         — In-app notification centre (Epic #363, GLO-004): bell + side panel + per-user preferences + SSE delivery + opt-in email digest + outbox-fanout producer
│   ├── 28-bulk-import.md           — Bulk Import Constituents (Epic #373): CSV/Excel upload, async worker pipeline, dedupe, 90-day retention, audit trail
│   ├── 29-global-search.md         — Global search / Command palette (Epic #364, GLO-001): Cmd+K overlay, Postgres FTS + pg_trgm, /v1/search RLS-scoped grouped results, RBAC-aware quick-create
│   ├── adrs/                       — Individual ADR files (incl. ADR-023 bucket topology, ADR-024 image pipeline, ADR-025 PDF code boundary, ADR-027 Swiss QR-bill, ADR-028 camt.053 ingestion, ADR-029 Keycloak session revocation, ADR-030 public-page archetype slots — hybrid shell + slot components per Epic #362, ADR-031 notification delivery + outbox fanout — SSE with polling fallback per Epic #363)
│   ├── runbooks/                   — Operator-driven one-shot ops (e.g. migrate-staging-keycloak-db.md for issue #283; launch-prod.md for the production-environment launch — issue #344); each file is plan + live journal + post-mortem. Also: bulk-email-stalled-job.md (recurring SRE triage flow for issue #326's Stalled / Partial bulk-email recovery), feature-flag-rollback.md (emergency psql + redis-cli flip when the Back Office page is unavailable), keycloak-backchannel-logout-cutover.md (per-env override of `backchannel.logout.url` after each realm sync — issue #76), and cross-tenant-rls-hardening-cutover.md (issue #430 — one-shot wiring of the `GIVERNANCE_APP_PASSWORD` secret + `givernance_app` role rotation that closes the staging cross-tenant notification leak)
│   ├── dev/
│   │   └── staging-secrets-setup.md — Reference for fork developers + the prod-launch runbook: every GH-Environment secret the deploy needs, how to generate it, how to rotate it (#343)
│   ├── vision/
│   │   └── conversational-mode.md — Future conversational AI mode (2026-2028)
│   ├── security/                  — Security audits & RBAC matrices (non-numbered, dated; e.g. rbac-audit-2026-04-27.md)
│   └── design/                    — 116 interactive HTML mockups (operator + donor + roadmap), realigned with the MVP shell + canonical `givernance-logo.svg`
├── diagrams/
│   ├── context.mmd       — C4 system context
│   ├── container.mmd     — C4 container diagram
│   ├── core-erd.mmd      — Entity-relationship diagram
│   ├── migration-flow.mmd — Salesforce migration flow
│   ├── postal-campaign-flow.mmd — End-to-end postal mailing + QR reconciliation (companion to docs/23)
│   ├── branding-upload-flow.mmd — Logo upload → process → activate → donor render (companion to docs/24)
│   ├── swiss-qr-bill-flow.mmd — Swiss QR-bill issuance: operator → donor → bank (companion to docs/25)
│   ├── camt053-reconciliation-flow.mmd — camt.053 import + match algorithm (companion to docs/25)
│   ├── public-page-styles-flow.mmd — Operator picks archetype → donor sees archetype (Epic #362, companion to docs/26)
│   ├── notifications-flow.mmd     — Outbox event → worker fanout → SSE delivery → panel + email digest (Epic #363, companion to docs/27)
│   └── bulk-import-flow.mmd — Bulk constituent import: download template → upload → poll → results (companion to docs/28)
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

**Phase 0 — Foundation (current)**: Architecture blueprint complete. 17 specification documents, 116 HTML mockups, 4 Mermaid diagrams. No production code yet.

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

### 🛑 Feature-flag-first rule (CRITICAL FOR NEW USER-FACING FEATURES)

**Every new user-facing feature ships behind a feature flag, default-off.** Read [`docs/18-feature-flags.md`](docs/18-feature-flags.md) — specifically § "What's actually shipped (Phase 1 MVP)" — before implementing. No flag = no PR for net-new behaviour. The shipped naming convention is dotted-domain `<domain>.<feature>` (e.g. `communication.bulk_email`); the `ff.` prefix shown in older agent docs is **stale** — match the live `FEATURE_FLAG_KEYS` shape in [`packages/shared/src/constants/feature-flags.ts`](packages/shared/src/constants/feature-flags.ts).

**When to flag (mandatory)**:
- New API endpoints, pages, navigation items, worker jobs, BullMQ processors
- Net-new visual surfaces (notification bell, command palette, style picker, dashboard tab)
- Any change donors / operators / super-admins see for the first time
- Super-admin-only features (dark-launch on prod before announcement counts)

**When NOT to flag**:
- Bug fixes to existing flagged-or-shipped features
- Pure infra / migration / dependency / CI / ops-runbook work
- Internal refactors with no behaviour change

**Five-step pattern for every new-feature PR**:
1. Append the key to `FEATURE_FLAG_KEYS` + `FEATURE_FLAG_REGISTRY` in [`packages/shared/src/constants/feature-flags.ts`](packages/shared/src/constants/feature-flags.ts). Engineering rationale (incident IDs, infra prerequisites, blocking conditions) goes in the **JSDoc above the entry**, never in the operator-facing `label` / `description`.
2. Ship the seed migration (`INSERT INTO feature_flags … ON CONFLICT (key) DO NOTHING`). The parity integration test in `packages/api/src/tests/integration/feature-flags.test.ts` fails CI on drift between registry and DB row.
3. Add `requireFlag(FEATURE_FLAG_KEYS.YOUR_KEY)` on every new route as the **FIRST** preHandler — before role guards — so scanners hit 404 without enumerating role requirements.
4. Add `isFlagEnabled(...)` at every new worker job pickup (defence-in-depth; the worker is the second wall if a request slipped through the API gate).
5. SSR-fetch `/v1/feature-flags` in the page server component, pass `xEnabled` down as a prop, and **hide every dependent surface** — buttons, columns, panels, bell icons, keyboard shortcuts — not just the primary action. A dead selection column on a disabled feature is operator-confusing UX.

**Off-state QA (mandatory before merge)**: with the flag off, the surface is *completely absent* — button hidden, column hidden, bell icon hidden, keyboard binding inactive, route returns 404 (not 403, not blank).

> ⚠ **Public-projection caveat**: `GET /v1/feature-flags` currently returns every registered key (name + enabled state) to every authenticated tenant user. Until a `public boolean` column lands on `feature_flags` (deferred follow-up), the key *name itself* is technically visible via DevTools. Pick names that don't tease an unreleased feature (`donation.public_page_styles` is fine; `donation.secret_q2_announcement` is not).

**Emergency rollback** for a broken flagged feature when the Back Office UI is unavailable: see [`docs/runbooks/feature-flag-rollback.md`](docs/runbooks/feature-flag-rollback.md) — `UPDATE feature_flags SET enabled = false …` + `redis-cli DEL flags:global`.

## Conventions

- Project name: **Givernance** (not "Libero", not "givernance-npo-platform")
- Terminology: **NPO** (nonprofit organization), not "NGO"
- GDPR in English docs, RGPD in French docs
- All docs are in `docs/`, numbered 01-29 for architecture specs (next free slot: `30-`)

### 🛑 Documentation discipline (CRITICAL FOR ALL DOMAIN WORK)

**Every domain feature in `docs/` is a contract** — with the operator, with prospects evaluating Givernance, and with the future-self maintaining the codebase. Drift between code and doc is a slow-burn outage: prospects evaluate against a doc that no longer matches the product, and onboarding new engineers loses days re-reading source to figure out what the doc forgot.

**For every PR that adds, changes, or removes domain behaviour, you MUST:**

1. **Find the matching `docs/NN-<domain>.md`** before writing code. If none exists for the domain you're touching, create it with the next free `NN-` number. The doc is the spec; the PR is the implementation of that spec.
2. **Update the doc in the same PR as the code.** A user-facing feature ships with three things: code, tests, and a doc section that explains:
   - **The user flow** (numbered Mermaid sequence diagram covering happy path + the most important error/edge branch)
   - **The domain model** (Mermaid `erDiagram` showing every new table + every new relationship to existing tables — and update `diagrams/core-erd.mmd` if a new table joins the core party/giving graph)
   - **The architecture** (which package owns what, where transactions / outbox / RLS boundaries are, what's sync vs. async)
   - **Permissions matrix** (every endpoint added, with its guard)
   - **Privacy / GDPR posture** (PII fields, audit trail, soft-delete propagation, erasure cascade)
   - **Future work explicitly out of scope** (so a prospect reading the doc understands the MVP vs. roadmap split)
3. **Cross-link**: every new doc names its related docs at the top (`> Related: …`), references the migration that ships its schema, and is added to the file tree in this CLAUDE.md.
4. **Diagrams**: a non-trivial flow needs its own `diagrams/<domain>-flow.mmd` companion. Keep `core-erd.mmd` in lockstep for any new tenant table that joins the core graph.
5. **Style**: follow the conventions of `docs/19-impersonation.md` and `docs/23-postal-campaigns.md` — the `## 0. Why this exists — at a glance` opening section is non-negotiable. A reader (operator, prospect, agent) who reads only that section must already understand what the feature does and why it matters.

**Reviewer checklist** (claude reviewing a domain PR):
- [ ] `docs/NN-*.md` exists for the domain
- [ ] User flow diagram is up to date with the actual code paths
- [ ] ERD reflects the schema after this PR
- [ ] Permissions matrix lists all new endpoints
- [ ] CLAUDE.md file tree is updated
- [ ] Out-of-scope section calls out the deferred work this PR explicitly chose not to do

**Why this is a hard rule**: Givernance is positioned as a transparent alternative to Salesforce NPSP. Prospects compare us on **what we openly explain**, not just what we ship. A feature that exists in the code but not in `docs/` cannot be evaluated, sold, or maintained — it's load-bearing complexity for the team without any external value. Treat the doc as a deliverable equal to the code.

A future user-facing documentation site (for end-customers and prospects) will be generated from these specs. Drift between specs and code propagates straight into the customer-facing surface — keep them in lockstep.

### 🛑 One Logical Database per Tool (ADR-017)

**Never co-locate an application schema with a third-party service's schema in the same Postgres logical database.** Each tool that needs Postgres storage gets its own logical DB and its own owner role on the shared instance.

Current topology:
- `givernance` — application data (Drizzle-managed), owner `givernance`, runtime role `givernance_app` (NOBYPASSRLS)
- `givernance_keycloak` — Keycloak's internal tables, owner `keycloak` (provisioned by `infra/postgres/init/01-init-keycloak-db.sh`)

When proposing a new service or Compose change that needs Postgres storage (e.g., adding Mailpit with a durable store, a second IdP, a workflow engine, an analytics sidecar), **do not reuse `givernance` or `givernance_keycloak`** — add a new logical DB + role in `infra/postgres/init/`, document it in the "Databases" table of `docs/infra/README.md`, and reference ADR-017. Co-locating is rejected in PR review. Rationale, rejected alternatives, and revisit criteria are in [`docs/15-infra-adr.md` → ADR-017](docs/15-infra-adr.md#adr-017-one-logical-database-per-tool--isolate-keycloak-from-the-application-db).

### 🛑 One Bucket per Visibility Class (ADR-023)

**Never co-locate object-storage assets of different visibility classes in the same bucket.** Every asset class first picks a visibility (public, private), and the bucket is determined by that visibility — never by the asset type. Per-tenant isolation lives in the **key prefix** (`{org_id}/…`), not in object-level ACLs.

Current topology:
- `receipts` — **private** (signed URLs only). Donor receipt PDFs.
- `campaigns` — **private** (signed URLs only). Postal-export ZIPs (Epic #274).
- `branding` — **public-read** at the bucket level, no per-object ACL. Org logos and their derived variants (Epic #286).
- `bank-statements` — **private** (signed URLs only). camt.053 ISO 20022 statements + rejected uploads (Epic #318). 10-year lifecycle (Swiss CO Art. 958f); versioning + MFA-delete enabled; SSE-S3 at rest; explicit public-access deny.

When proposing a new asset class (campaign hero in Phase 2, favicon, OG share image, document attachments, member profile photos, etc.), **first ask: is this donor-public or org-private?** Public-read goes to `branding` (or a new public-read bucket if a different lifecycle is needed); private goes to `receipts`/`campaigns` (or a new private bucket). **Never mix the two in one bucket** — object-level ACLs in a primarily-private bucket are the foot-gun GDPR audits flag and break CDN edge caching for the public-read keys. Co-mingling is rejected in PR review. Rationale, rejected alternatives, and revisit criteria are in [`docs/15-infra-adr.md` → ADR-023](docs/adrs/adr-023-object-storage-bucket-topology.md).

### 🛑 Closing multiple issues in one PR

**Never use a comma-separated list or the `fix` / `fixes` keyword to close multiple issues from a PR description.** GitHub's auto-close behavior is unreliable on this repo for those forms — only some of the referenced issues actually close at merge time.

Instead, write one `close` directive **per line**, with one issue number per directive:

```
close #161
close #181
close #182
```

Apply this in `gh pr create` / `gh pr edit` bodies, in commit messages that close issues, and in any PR template. Use `close` (not `closes`, not `fix`, not `fixes`).

### 🛑 RLS is the safety net, never the contract (issue #430)

**Every tenant-scoped Drizzle query MUST filter by `eq(<table>.orgId, ctx.orgId)` (or equivalent) explicitly, in addition to whatever RLS policy applies.** RLS — `users.tenant_isolation`, etc. — is defence in depth. The contract is the application code.

**Why this is non-negotiable**: on 2026-05-23 staging produced a cross-tenant notification leak. The notification fanout query was `SELECT id FROM users WHERE role='org_admin'` with no `eq(orgId, …)`, relying entirely on RLS to scope. RLS was active and forced on `users`. But `DATABASE_URL_APP` had been misconstructed in the kamal-secrets composite action to use the **owner role `givernance`** (`rolbypassrls=t`) instead of the intended `givernance_app` (`rolbypassrls=f`). Every RLS-dependent query in the API + worker silently bypassed RLS. The audit traced 26 query sites with this anti-pattern; all are fixed in PR #430.

**What "explicit" means**:
- Reads: `where(and(eq(<table>.orgId, ctx.orgId), …other predicates))`
- Mutations (`update`/`delete`): same predicate in the `where(...)`
- Joined SELECTs: the `eq(orgId, …)` predicate appears on the root table AND on every join clause (or in the join's `on` condition)
- PK lookups: keep the `eq(<table>.orgId, …)` even when the PK looks like it implies the tenant — a leaked or guessed UUID is the entire reason this rule exists
- Owner-pool (`systemDb`) cross-tenant queries: legitimate but rare; document the cross-tenant intent in a comment, and even then add `eq(orgId, …)` whenever a tenant is in scope (e.g. branding-asset lookup by PK, where the tenant pointer can drift)

**Defence-in-depth, not "instead of"**: every tenant-scoped table also has RLS enabled + forced via [`packages/api/migrations/0012_force_rls.sql`](packages/api/migrations/0012_force_rls.sql) and per-table policies. The boot-time `assertAppRoleSecure` / `assertWorkerAppRoleSecure` guards in [`packages/api/src/lib/db.ts`](packages/api/src/lib/db.ts) + [`packages/worker/src/lib/db.ts`](packages/worker/src/lib/db.ts) crash-loop the container if `DATABASE_URL_APP` ever connects as a BYPASSRLS role again. The three together — explicit filter, RLS policy, boot guard — make a future deploy-config bug a deploy failure, not a silent data leak.

**Reviewer checklist** (claude reviewing any PR that adds a Drizzle query):
- [ ] Every tenant-scoped read/write has `eq(<table>.orgId, …)` (or equivalent) **in the application code**, not just relying on RLS.
- [ ] No new `systemDb` use without a comment justifying the cross-tenant intent.
- [ ] If the query is inside a worker processor, the `withWorkerContext(orgId, …)` wrapper is present AND the inner query carries the explicit `eq(orgId, …)`.

### 🛑 No secrets in Keycloak Organization attributes (issue #114)

**Never put secrets, API keys, billing tokens, or any sensitive data into a Keycloak Organization's `attributes` map.** The `organization` client scope (attached as default to `givernance-web` and as optional to `admin-cli`) carries an `oidc-organization-membership-mapper` configured with `addOrganizationAttributes=true`, which emits every organization attribute into every access, ID, and introspection token for members of that org. Any secret stashed there will leak to the browser and every downstream service that sees the JWT.

Valid uses for Organization attributes: non-sensitive identifiers (`org_id`, slug), feature flags that don't imply entitlements (`theme`, `locale`), public-facing labels. Anything else belongs in the application database (`tenants` table) with RLS.

### 🛑 Drizzle migrations: journal must stay in sync with the folder

**Adding a `.sql` file to [`packages/api/migrations/`](packages/api/migrations/) is not enough — the migration must also be registered in [`packages/api/migrations/meta/_journal.json`](packages/api/migrations/meta/_journal.json).** `drizzle-kit migrate` (run by CI as `pnpm db:migrate` before tests) only applies migrations listed in the journal; unregistered SQL files are silently skipped. The Epic #363 follow-up hit this exact gap — `0056_notifications_panel_visible.sql` was on disk but missing from the journal, so CI's test Postgres never got the new column and every integration test that touched it failed with `42703 column … does not exist`. Local dev didn't catch it because the developer had `psql < 0056_*.sql`'d the column in by hand while iterating.

**When this rule fires** (audit the journal in each of these cases):
- **Adding a hand-written migration** (you're not running `drizzle-kit generate`): append a journal entry yourself.
- **Rebasing onto `main`** when both your branch and main added migrations in parallel: re-check that `idx` is contiguous, `tag`s match filenames, and `when` is strictly increasing.
- **Cherry-picking a commit** that included a migration: confirm the journal change rode along (not just the `.sql`).
- **Resolving a merge conflict that touched `_journal.json`**: walk every entry by hand — `git`'s line-based merge does not know that journal entries are positional.

**How to append manually** (for hand-written migrations like new columns / constraints / seeds that don't come from a schema diff):
1. Decide on the next free `NNNN` prefix for the filename. Check the highest current `idx` in the journal.
2. Add an entry at the end of `entries[]`:
   ```json
   {
     "idx": <highestIdx + 1>,
     "version": "7",
     "when": <previousEntry.when + 10_000_000_000>,
     "tag": "<filename without .sql>",
     "breakpoints": true
   }
   ```
3. `tag` must match the filename exactly (minus `.sql`). The `when` field is an arbitrary monotonic counter in this repo, not a real timestamp — preserve the +10b spacing so future rebases stay easy.

**Automated guard**: [`packages/api/src/tests/integration/migrations-journal-parity.test.ts`](packages/api/src/tests/integration/migrations-journal-parity.test.ts) fails CI on orphan files, phantom journal entries, gappy `idx`, and non-monotonic `when`. If that test goes red after an edit, the journal is the thing to fix — never the test.

---

## 🛑 DEV PROCESS (CRITICAL FOR CI)

**Every time you commit code in this repository, YOU MUST ENSURE the GitHub Actions CI pipeline will pass.**

Before concluding your task or pushing to origin, you must run and verify:
1. `pnpm install` (to sync dependencies)
2. `pnpm build` (to check compilation)
3. `pnpm run format` (auto-fix Biome formatting)
4. `pnpm typecheck` (catch TypeScript strict errors)
5. `pnpm test` (ensure the integration tests still pass)
6. **`pnpm biome check .`** (final gate — this is the EXACT command CI runs; matches lint + format-check together)

If any of these fail, **fix the underlying issue** before pushing. Never leave a branch with a failing `typecheck` or `lint` command.

⚠ **Step 6 is the load-bearing one.** `pnpm run lint` is check-only and `pnpm run format` only auto-fixes — running them separately lets format drift sneak back in if you make edits between or after them. CI runs `pnpm biome check .` which combines both, so that's what you must run **last**, after every other edit, immediately before `git push`. If it returns non-zero, run `pnpm biome check --write .` to auto-fix, then re-run `pnpm biome check .` to confirm clean.
