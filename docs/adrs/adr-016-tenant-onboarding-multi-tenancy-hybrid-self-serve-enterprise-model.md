## ADR-016: Tenant Onboarding & Multi-Tenancy — Hybrid Self-Serve + Enterprise Model

- **Status**: Proposed
- **Date**: 2026-04-23
- **Deciders**: Magino (founder/architect), team design session 2026-04-23
- **Related**: `docs/21-authentication-sso.md`, `docs/22-tenant-onboarding.md`, Spike [#80](https://github.com/purposestack/givernance/issues/80), ADR-009 (data residency), ADR-011 (layered frontend), ADR-013 (type boundary)

### Context

Phase 1 shipped a super-admin-only tenant provisioning path (`POST /v1/tenants` guarded by `requireAdminSecret`) and a Keycloak OIDC login flow (`docs/21-authentication-sso.md`). Spike #80 chose a shared Keycloak realm with groups + attributes (Option A) and concluded that a Givernance platform operator would provision every tenant from the back-office. That design is correct for the enterprise segment but does **not** cover the long tail of tiny European NPOs that Givernance targets:

- Most French associations under 20 staff have **no corporate email domain** — they run on gmail / outlook / proton personal inboxes (`greg-field-insights` §3, team design session 2026-04-23).
- Super-admin-only provisioning does not scale from 5 pilots to hundreds of tenants, and it is a conversion-killer for a self-serve SMB segment.
- The earlier (now-deprecated) "5-step onboarding wizard" from issue #33 predates the SSO-only decision and cannot be resurrected as-is.

The team design session (2026-04-23) reopened these questions and concluded that **both paths must coexist**: enterprise tenants whose admin is provisioned by a platform operator, and SMB tenants who self-serve from a public signup form using personal email.

### Decision

Givernance adopts a **hybrid tenant onboarding model** with three tenant tracks, all living in the same shared Keycloak realm and same PostgreSQL cluster:

| Track | Who creates the tenant | First-admin identity | IdP federation | Example |
|---|---|---|---|---|
| **Self-serve (SMB)** | Public signup form; first user becomes *provisional* `org_admin` | Personal email, OTP-verified via Keycloak | None — Keycloak local authenticator (password / magic link) | Tiny French NPO using `tresorier@gmail.com` |
| **Enterprise SSO** | Givernance super-admin from the back-office | Domain-verified corporate email, JIT-provisioned from IdP claims | Per-tenant OIDC / SAML IdP (Entra, Okta, Google Workspace) wired to the shared realm | Red Cross France, Médecins du Monde |
| **Invitation-join** | Another tenant's `org_admin` invites the user by email | The invited email (personal or corporate) | Inherits the target tenant's IdP (if any) | Volunteer board member joining an existing NPO |

All three tracks produce the same domain model: a `tenants` row, an optional `tenant_domains` row set (enterprise only), and `users` rows created **Just-In-Time** on first SSO login via trusted Keycloak JWT claims (`sub`, `email`, `org_id`, `role`). RLS isolation on `org_id` remains the sole tenancy boundary at the database layer.

**Platform primitives adopted**:

1. **Keycloak Organizations** (Keycloak 26+) replaces the ad-hoc groups-and-attributes approach from Spike #80. Organizations is GA as of Keycloak 26.0 and provides first-class org entities with domain-based IdP routing, per-org IdP bindings, and invitation flows.
2. **URL-path tenant scoping** (`app.givernance.app/<org-slug>/…`) — **not** subdomain scoping. One wildcard TLS cert, no DNS propagation delay at tenant creation, no cross-subdomain cookie leakage. Subdomain routing is reserved for a future Enterprise tier where perception matters (Cloudflare for SaaS).
3. **Provisional `org_admin` with grace period** — on self-serve, the first user is `org_admin` for 7 days; other verified users from the same domain can dispute within that window. Destructive actions (delete-org, export-all) are gated behind verification.
4. **No credit card at signup** — 30-day trial, then card *or* annual invoice at conversion. This matches the NPO segment's procurement realities.
5. **Disposable-email + IP/ASN rate limits** as first-order abuse filters. Payment is **not** used as a signup filter; it is reserved for conversion.
6. **Post-login organization picker** — a single user can belong to multiple tenants; `org_id` is minted into the access token at picker time and re-minted on switch. Refresh token is user-scoped.

### Rationale

- **Two-track design reflects customer reality.** Treating the long-tail SMB as an afterthought on top of an enterprise-first design yields worst-of-both-worlds UX. Treating enterprise as an afterthought on top of SMB fails audits. Two tracks with shared infrastructure is the 2026 consensus (WorkOS Organizations, Clerk Organizations, Stytch B2B).
- **Keycloak Organizations over custom group/attribute plumbing.** The groups-and-attributes approach chosen in Spike #80 predates Keycloak 26. For a product starting to add tenants in 2026, Organizations is the right primitive: fewer custom mappers, native Home IdP Discovery, built-in invitation templates, actively developed.
- **URL-path over subdomain** avoids wildcard-TLS provisioning, cross-subdomain cookie pitfalls, and per-tenant DNS operations — and it unlocks *instant* tenant creation, which the self-serve flow requires.
- **Provisional admin with grace period** prevents the "random intern becomes org_admin" failure mode without blocking legitimate self-serve signup.
- **RLS unchanged** — this ADR adds primitives around identity but leaves the data-layer tenancy model (single shared application database, `org_id`-scoped RLS, 3-role Postgres pattern) exactly as decided in ADR-009. "Single shared" here refers to the application DB; Keycloak's storage has been split out into `givernance_keycloak` by [ADR-017](#adr-017-one-logical-database-per-tool--isolate-keycloak-from-the-application-db).
- **Card-at-conversion, not signup** — nonprofit budgets are annual and board-approved; card-at-signup is a conversion killer for this segment (ProfitWell / Baymard SMB benchmarks). Reserve card-at-signup for a future high-abuse scenario.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Super-admin-only provisioning (Spike #80 as-is) | Strong control; simple model | Does not scale; kills SMB conversion; blocks self-serve pilots | Rejected — retained as the enterprise track only |
| First-user-becomes-admin with no safeguards (2026-04-23 naive variant) | Dead simple | Random employee can lock out real admins; no path to revoke | Rejected — replaced by provisional-admin-with-grace-period |
| Paywall at signup as anti-abuse filter | Eliminates bots; validates intent | Conversion-killer for SMB NPOs; EU dark-pattern regulations (DGCCRF / ACM enforcement) | Rejected — moved to conversion event |
| Subdomain-per-tenant (`<ngo>.givernance.app`) from day one | Enterprise perception; strong isolation | Wildcard TLS operations, cross-subdomain cookie issues, delayed provisioning | Rejected for MVP — reserved for future Enterprise tier with Cloudflare for SaaS |
| One Keycloak realm per tenant | Hard IdP isolation; per-realm branding | Thousands of realms = operational explosion; tested by Spike #80 and rejected | Rejected — retained only as the self-hosted "dedicated realm" escape hatch |
| Keycloak groups + attributes (Spike #80 Option A) | Works today; no Keycloak 26 upgrade needed | Requires custom domain routing, custom mappers, manual invitation plumbing; Organizations supersedes it | Rejected for net-new work — existing groups/attributes in the dev seed will be migrated |
| Email domain as sole tenant-binding authority | Zero UX friction | Personal-email orgs locked out; someone at `intern@ngo.fr` cannot bind BigCorp; no DNS proof | Rejected — domain is one signal of many, with DNS TXT as the hard gate for enterprise |

### Consequences

- **Keycloak upgrade required** — infra target becomes Keycloak 26.x. Issue #61 (split Keycloak DB) becomes a prerequisite; migrating the dev realm seed from groups/attributes to Organizations is scheduled in this milestone.
- **Schema additions** — `tenants` gets `status` ∈ `provisional | active | suspended | archived`, `verified_at`, `created_via` ∈ `self_serve | enterprise | invitation`; new tables `tenant_domains` (domain + DNS TXT verification state), `tenant_admin_disputes` (grace-period dispute log). Existing Phase 1 `tenants` schema is kept backward-compatible.
- **API additions** — `POST /v1/public/signup`, `POST /v1/public/email-verify`, `POST /v1/admin/tenants/:id/provision-idp`, `GET /v1/users/me/organizations`, `POST /v1/session/switch-org`, `POST /v1/tenants/:id/domains`, `POST /v1/tenants/:id/domains/:domain/verify`. All enterprise-admin endpoints on the existing `packages/api/src/modules/admin/` / `…/tenants/` boundaries; self-serve endpoints live under a new `public` module that skips tenant context until the target org is resolved.
- **Frontend additions** — public signup/verify pages, organization picker screen, back-office admin screens for tenants+domains+IdP config, provisional-admin banner in the app shell (reusing the impersonation banner pattern from PR #73).
- **Docs 21 update** — `docs/21-authentication-sso.md` is refactored to reference this ADR + `docs/22-tenant-onboarding.md` instead of embedding the obsolete super-admin-only flow.
- **Issue #80 remains open** as an architectural context doc; implementation issues under the new milestone "Tenant Onboarding & Multi-Tenancy" replace it.
- **Issue #78** (onboarding wizard Steps 2–4) is rebaselined on the hybrid flow; Step 1 becomes the public signup form, Step 5 becomes the provisional-admin welcome.
- **Issue #33** (old 5-step wizard) is closed as superseded.
- **Abuse surface** — new public endpoints require rate limiting (Fastify `@fastify/rate-limit`, Redis store), disposable-email blocklist, CAPTCHA (hCaptcha) on signup, and an audit trail of every signup attempt (`audit_logs.action = 'tenant.signup_attempted'`).
- **GDPR posture** — signup form collects minimal PII (email + display name); country/legal-type asked in-product after signup; DPO email collected at verification step, aligning with Phase 2 GDPR consent work in #78.

### Revisit criteria

- If self-serve abuse (fake tenants, spam sends) exceeds a threshold (e.g., > 5% of new tenants flagged in 30 days), evaluate moving to "payment card at signup" for self-serve track only.
- If multi-domain orgs (one NPO with `ngo.fr` and `ngo.org` both valid) are not well-served by Keycloak Organizations (edge cases in domain verification or Home IdP Discovery), revisit the Organizations adoption.
- If subdomain-per-tenant demand from enterprise tenants emerges before the Cloudflare-for-SaaS investment is justified, we either ship a coarser DNS-per-tenant flow or keep URL-path scoping and defer.

---

