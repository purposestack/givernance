# RBAC audit — 2026-04-27

> Phase 1 deliverable for issue #162. Comprehensive inventory of every API
> route and every authenticated frontend page in the Givernance modular
> monolith, paired with a target matrix and gap analysis. Produced by the
> `security-architect` subagent against the codebase at HEAD `1295170`.

## Scope

- **Source-of-truth roles**: `org_admin`, `user`, `viewer` (application
  roles, persisted in `users.role`) plus the platform-level `super_admin`
  realm role from Keycloak. No other roles exist in code today.
- **In-scope**: every `app.<verb>(...)` registration under
  `packages/api/src/modules/*/routes.ts` (mounted at `/v1` except health),
  every `page.tsx` under `packages/web/src/app/(app)/**`, and the
  field-level read/write semantics of the main entities.
- **Out of scope**: `(auth)`, `(public)`, `(admin)` web layouts (separate
  trust zones audited elsewhere); RLS / multi-tenancy isolation
  (covered by `withTenantContext` and ADR-016/017); Keycloak token
  issuance and the impersonation flow (issue #24).

## Method

1. Read the 5 production guard primitives in
   [`packages/api/src/lib/guards.ts`](../../packages/api/src/lib/guards.ts):
   `requireAuth`, `requireWrite`, `requireOrgAdmin`,
   `requireSuperAdmin`, `requireSuperAdminOrOwnOrgAdmin`, plus the
   header-based `requireAdminSecret` for control-plane endpoints.
2. Walked every route file under
   [`packages/api/src/modules/`](../../packages/api/src/modules/) and
   captured the `preHandler` actually wired on each registration.
3. Walked every `page.tsx` under
   [`packages/web/src/app/(app)/`](../../packages/web/src/app/\(app\)/)
   and captured the server-side guard call plus any role-conditional
   rendering inside the component.
4. For each row produced a target guard, then derived the gap list and
   severity classification using the legend in §C.

## Guard primitive cheat-sheet

| Guard | Allowed roles | Typical use |
|---|---|---|
| `requireAuth` | any authenticated user (incl. `viewer`) | reads + the user's own resource |
| `requireWrite` | `org_admin`, `user` | operational create / update of fundraising data |
| `requireOrgAdmin` | `org_admin` only | destructive ops, settings, member management, reports |
| `requireSuperAdmin` | realm role `super_admin` | platform admin (returns 404 to non-supers — anti-disclosure) |
| `requireSuperAdminOrOwnOrgAdmin` | `super_admin` OR `org_admin` of `params.orgId` | tenant-scoped admin endpoints (domain CRUD, tenant settings) |
| `requireAdminSecret` | bearer of `x-admin-secret` (timing-safe compare) | provisioning / control-plane endpoints |

Frontend permission map
([`packages/web/src/lib/auth/guards.ts`](../../packages/web/src/lib/auth/guards.ts)):

| Permission | Allowed roles |
|---|---|
| `admin` | `org_admin` |
| `write` | `org_admin`, `user` |
| `read` | `org_admin`, `user`, `viewer` |

---

## Phase A — Discovery: current state

### Table A1 — API routes (mounted at `/v1` unless noted)

| Module | Method + Path | File:line | Current guard | Notes |
|---|---|---|---|---|
| admin | DELETE `/v1/admin/impersonation/:sessionId` | `modules/admin/impersonation-routes.ts:12` | `requireSuperAdmin` | Ends an impersonation session; clears JWT cookie. |
| audit | GET `/v1/audit` | `modules/audit/routes.ts:29` | `requireOrgAdmin` | Paginated tenant audit log. |
| campaigns | GET `/v1/campaigns` | `modules/campaigns/routes.ts:146` | `requireAuth` | List with pagination. |
| campaigns | POST `/v1/campaigns` | `modules/campaigns/routes.ts:173` | `requireWrite` | Idempotency-keyed create. |
| campaigns | GET `/v1/campaigns/:id` | `modules/campaigns/routes.ts:223` | `requireAuth` | Single campaign read. |
| campaigns | PATCH `/v1/campaigns/:id` | `modules/campaigns/routes.ts:263` | `requireWrite` (+ in-handler `org_admin`-only check on `body.status`) | Field-level admin gate on status transitions. |
| campaigns | GET `/v1/campaigns/:id/funds` | `modules/campaigns/routes.ts:322` | `requireAuth` | Funds eligible for a campaign. |
| campaigns | POST `/v1/campaigns/:id/close` | `modules/campaigns/routes.ts:350` | `requireOrgAdmin` | Soft-delete (status → closed). |
| campaigns | GET `/v1/campaigns/:id/stats` | `modules/campaigns/routes.ts:379` | `requireAuth` | Total raised / donor count / unique donors. |
| campaigns | GET `/v1/campaigns/:id/roi` | `modules/campaigns/routes.ts:407` | `requireAuth` | ROI read-model. |
| campaigns | POST `/v1/campaigns/:id/documents` | `modules/campaigns/routes.ts:435` | `requireOrgAdmin` | Idempotency-keyed batch document generation. |
| constituents | GET `/v1/constituents` | `modules/constituents/routes.ts:138` | `requireAuth` | List with search/filter. |
| constituents | GET `/v1/constituents/:id` | `modules/constituents/routes.ts:179` | `requireAuth` | Single read. |
| constituents | GET `/v1/constituents/duplicates/search` | `modules/constituents/routes.ts:215` | `requireWrite` (this PR) | Pre-flight to create — soft-PII gate. |
| constituents | POST `/v1/constituents` | `modules/constituents/routes.ts:241` | `requireWrite` (this PR) | Original symptom of issue #162. |
| constituents | PUT `/v1/constituents/:id` | `modules/constituents/routes.ts:295` | `requireWrite` (this PR) | Update. |
| constituents | DELETE `/v1/constituents/:id` | `modules/constituents/routes.ts:341` | `requireOrgAdmin` | Soft-delete; admin-only. |
| constituents | POST `/v1/constituents/:id/merge` | `modules/constituents/routes.ts:370` | `requireOrgAdmin` | RFC 7232 conditional merge. |
| disputes | POST `/v1/tenants/:orgId/admin-dispute` | `modules/disputes/routes.ts:76` | `requireAuth` (+ in-handler same-tenant check) | Provisional-admin dispute window. |
| disputes | GET `/v1/admin/disputes` | `modules/disputes/routes.ts:134` | `requireSuperAdmin` | Triage queue. |
| disputes | GET `/v1/admin/disputes/:id` | `modules/disputes/routes.ts:155` | `requireSuperAdmin` | Detail. |
| disputes | PATCH `/v1/admin/disputes/:id` | `modules/disputes/routes.ts:178` | `requireSuperAdmin` | Resolution. |
| donations | GET `/v1/donations` | `modules/donations/routes.ts:170` | `requireAuth` | Paginated list with filters. |
| donations | GET `/v1/donations/:id` | `modules/donations/routes.ts:214` | `requireAuth` | Detail with allocations. |
| donations | POST `/v1/donations` | `modules/donations/routes.ts:251` | `requireAuth` | Idempotency-keyed manual donation. **Gap.** |
| donations | PATCH `/v1/donations/:id` | `modules/donations/routes.ts:327` | `requireAuth` | Update. **Gap.** |
| donations | DELETE `/v1/donations/:id` | `modules/donations/routes.ts:385` | `requireAuth` | Delete. **Gap.** |
| donations | GET `/v1/donations/:id/receipt` | `modules/donations/routes.ts:422` | `requireAuth` | Presigned S3 URL for tax receipt. |
| funds | GET `/v1/funds` | `modules/funds/routes.ts:54` | `requireAuth` | List. |
| funds | POST `/v1/funds` | `modules/funds/routes.ts:80` | `requireOrgAdmin` | Create. |
| funds | GET `/v1/funds/:id` | `modules/funds/routes.ts:111` | `requireAuth` | Detail. |
| funds | PATCH `/v1/funds/:id` | `modules/funds/routes.ts:138` | `requireOrgAdmin` | Update. |
| funds | DELETE `/v1/funds/:id` | `modules/funds/routes.ts:176` | `requireOrgAdmin` | Conflict-aware delete. |
| health | GET `/healthz` | `modules/health/routes.ts:13` | none | Liveness probe — public. |
| health | GET `/readyz` | `modules/health/routes.ts:22` | none | Readiness probe with DB check — public. |
| invitations | POST `/v1/invitations` | `modules/invitations/routes.ts:174` | `requireOrgAdmin` | Invite teammate. |
| invitations | GET `/v1/invitations` | `modules/invitations/routes.ts:224` | `requireOrgAdmin` | List pending/accepted. |
| invitations | POST `/v1/invitations/:id/resend` | `modules/invitations/routes.ts:264` | `requireOrgAdmin` (+ rate-limited) | Rotate token + re-emit. |
| invitations | DELETE `/v1/invitations/:id` | `modules/invitations/routes.ts:306` | `requireOrgAdmin` | Revoke pending. |
| invitations | GET `/v1/invitations/:token/probe` | `modules/invitations/routes.ts:368` | none (rate-limited) | Public token check; token IS the credential. |
| invitations | POST `/v1/invitations/:token/accept` | `modules/invitations/routes.ts:419` | none (rate-limited) | Public accept; token IS the credential. |
| payments | POST `/v1/admin/stripe-connect` | `modules/payments/routes.ts:30` | `requireOrgAdmin` | Stripe Connect onboarding. |
| payments | POST `/v1/donations/stripe-webhook` | `modules/payments/routes.ts:81` | none (signature-verified, rate-limited) | Stripe webhook; signature is the credential. |
| pledges | POST `/v1/pledges` | `modules/pledges/routes.ts:76` | `requireAuth` | Idempotency-keyed pledge create. **Gap.** |
| pledges | GET `/v1/pledges/:id/installments` | `modules/pledges/routes.ts:114` | `requireAuth` | List installments. |
| public | GET `/v1/campaigns/:id/public-page` | `modules/public/routes.ts:61` | `requireOrgAdmin` | Admin fetch of public-page config. |
| public | GET `/v1/public/campaigns/:id/page` | `modules/public/routes.ts:95` | none | Published page config — public. |
| public | GET `/v1/public/qr/:code` | `modules/public/routes.ts:131` | none (rate-limited) | Resolve QR token. |
| public | POST `/v1/public/campaigns/:id/donate` | `modules/public/routes.ts:168` | none (rate-limited) | Public PaymentIntent — donor not authenticated. |
| public | PUT `/v1/campaigns/:id/public-page` | `modules/public/routes.ts:224` | `requireOrgAdmin` | Admin upsert of public-page config. |
| reports | GET `/v1/reports/lybunt` | `modules/reports/routes.ts:31` | `requireOrgAdmin` | LYBUNT lifecycle. |
| reports | GET `/v1/reports/sybunt` | `modules/reports/routes.ts:63` | `requireOrgAdmin` | SYBUNT lifecycle. |
| session | GET `/v1/users/me/organizations` | `modules/session/routes.ts:62` | `requireAuth` | Membership cards for org-picker. |
| session | POST `/v1/session/switch-org` | `modules/session/routes.ts:82` | `requireAuth` (+ in-handler block on impersonated sessions) | Validate + record + blocklist. |
| signup | POST `/v1/public/signup` | `modules/signup/routes.ts:130` | none (rate-limited, CAPTCHA) | Provisional self-serve tenant create. |
| signup | POST `/v1/public/signup/resend` | `modules/signup/routes.ts:215` | none (per-IP + per-email rate limit) | Verification email resend. |
| signup | POST `/v1/public/signup/verify` | `modules/signup/routes.ts:243` | none (rate-limited, token = credential) | Complete signup. |
| signup | GET `/v1/public/tenants/lookup` | `modules/signup/routes.ts:304` | none (rate-limited) | Tenant discovery hint. |
| tenant-admin | POST `/v1/superadmin/tenants` | `modules/tenant-admin/routes.ts:252` | `requireSuperAdmin` | Create enterprise tenant. |
| tenant-admin | GET `/v1/superadmin/tenants` | `modules/tenant-admin/routes.ts:317` | `requireSuperAdmin` | List + filter. |
| tenant-admin | GET `/v1/superadmin/tenants/:id/detail` | `modules/tenant-admin/routes.ts:338` | `requireSuperAdmin` | Detail + tabs. |
| tenant-admin | POST `/v1/superadmin/tenants/:id/provision-idp` | `modules/tenant-admin/routes.ts:363` | `requireSuperAdmin` | Provision OIDC/SAML. |
| tenant-admin | PATCH `/v1/superadmin/tenants/:id/idp` | `modules/tenant-admin/routes.ts:413` | `requireSuperAdmin` | Rotate config. |
| tenant-admin | DELETE `/v1/superadmin/tenants/:id/idp` | `modules/tenant-admin/routes.ts:461` | `requireSuperAdmin` | Unbind + remove IdP. |
| tenant-admin | POST `/v1/superadmin/tenants/:id/lifecycle` | `modules/tenant-admin/routes.ts:485` | `requireSuperAdmin` | Suspend / archive / activate. |
| tenant-admin | POST `/v1/superadmin/tenants/:id/first-admin-invitations` | `modules/tenant-admin/routes.ts:524` | `requireSuperAdmin` | Seed first user. |
| tenant-admin | POST `/v1/superadmin/tenants/:id/first-admin-invitations/:invitationId/resend` | `modules/tenant-admin/routes.ts:600` | `requireSuperAdmin` (+ rate-limited) | Rotate token + re-emit. |
| tenant-admin | DELETE `/v1/superadmin/tenants/:id/first-admin-invitations/:invitationId` | `modules/tenant-admin/routes.ts:658` | `requireSuperAdmin` | Revoke. |
| tenant-admin | POST `/v1/tenants/:orgId/domains` | `modules/tenant-admin/routes.ts:718` | `requireSuperAdminOrOwnOrgAdmin` | Claim domain. |
| tenant-admin | POST `/v1/tenants/:orgId/domains/:domain/verify` | `modules/tenant-admin/routes.ts:761` | `requireSuperAdminOrOwnOrgAdmin` | DNS TXT lookup. |
| tenant-admin | DELETE `/v1/tenants/:orgId/domains/:domain` | `modules/tenant-admin/routes.ts:810` | `requireSuperAdminOrOwnOrgAdmin` | Revoke domain (soft). |
| tenants | GET `/v1/admin/tenants/:orgId` | `modules/tenants/routes.ts:117` | `requireSuperAdminOrOwnOrgAdmin` | Fetch tenant settings. |
| tenants | PUT `/v1/admin/tenants/:orgId` | `modules/tenants/routes.ts:146` | `requireSuperAdminOrOwnOrgAdmin` | Update tenant settings (locale, base currency). |
| tenants | GET `/v1/admin/tenants/:orgId/snapshot` | `modules/tenants/routes.ts:188` | `requireSuperAdminOrOwnOrgAdmin` | Tenant data snapshot export. |
| tenants | POST `/v1/tenants` | `modules/tenants/routes.ts:217` | `requireAdminSecret` | Control-plane tenant create. |
| tenants | GET `/v1/tenants` | `modules/tenants/routes.ts:258` | `requireAdminSecret` | Control-plane tenant list. |
| tenants | GET `/v1/tenants/:id` | `modules/tenants/routes.ts:274` | `requireAdminSecret` | Control-plane tenant detail. |
| tenants | DELETE `/v1/tenants/:id` | `modules/tenants/routes.ts:303` | `requireAdminSecret` | Control-plane tenant delete. |
| users | GET `/v1/users/me` | `modules/users/routes.ts:86` | `requireAuth` | Caller's profile. |
| users | PATCH `/v1/users/me` | `modules/users/routes.ts:157` | `requireAuth` | Caller updates own preferences (locale). |
| users | GET `/v1/users` | `modules/users/routes.ts:252` | `requireOrgAdmin` | List tenant users. |
| users | POST `/v1/users` | `modules/users/routes.ts:271` | `requireOrgAdmin` | Create user (provisioning path; deprecated by invitations). |
| users | PATCH `/v1/users/:id/role` | `modules/users/routes.ts:317` | `requireOrgAdmin` | Update role. |
| users | DELETE `/v1/users/:id` | `modules/users/routes.ts:357` | `requireOrgAdmin` | Remove user. |

### Table A2 — Frontend `(app)` pages

| Route | File:line | Current guard | Role-conditional UI affordances |
|---|---|---|---|
| `/dashboard` | `app/(app)/dashboard/page.tsx:34` | `requireAuth()` | None — read-only KPIs and recent-activity widgets visible to every role. |
| `/profile` | `app/(app)/profile/page.tsx:18` | `requireAuth()` | None — every user sees their own preferences form. |
| `/constituents` | `app/(app)/constituents/page.tsx:32` | `requireAuth()` | "+ New" CTA gated on `canWrite` (`org_admin` ∪ `user`); table actions gated on `canManageAdminActions` (`org_admin`). |
| `/constituents/new` | `app/(app)/constituents/new/page.tsx:7` | `requirePermission("write")` (this PR) | Form unconditionally rendered to allowed roles. |
| `/constituents/[id]` | `app/(app)/constituents/[id]/page.tsx:84` | `requireAuth()` | "Edit" CTA visible to all (this PR removes it from viewer); "Merge" + "Delete" CTAs gated on `canManageAdminActions`; "Export GDPR" stub visible to all. |
| `/constituents/[id]/edit` | `app/(app)/constituents/[id]/edit/page.tsx:30` | `requirePermission("write")` (this PR) | Form unconditionally rendered. |
| `/donations` | `app/(app)/donations/page.tsx:45` | `requireAuth()` | "+ New" CTA unconditionally visible. **Gap.** |
| `/donations/new` | `app/(app)/donations/new/page.tsx:7` | `requireAuth()` | Form unconditionally rendered. **Gap.** |
| `/donations/[id]` | `app/(app)/donations/[id]/page.tsx:43` | `requireAuth()` | "Edit" CTA + "Delete" button unconditionally visible. **Gap.** |
| `/donations/[id]/edit` | `app/(app)/donations/[id]/edit/page.tsx:31` | `requireAuth()` | Form unconditionally rendered. **Gap.** |
| `/campaigns` | `app/(app)/campaigns/page.tsx:31` | `requireAuth()` | "+ New" CTA unconditionally visible. **Gap.** Table-row admin actions gated on `canManageAdminActions`. |
| `/campaigns/new` | `app/(app)/campaigns/new/page.tsx:7` | `requireAuth()` | Form unconditionally rendered. **Gap.** |
| `/campaigns/[id]` | `app/(app)/campaigns/[id]/page.tsx:79` | `requireAuth()` | "Edit" CTA unconditionally visible. **Gap.** "Public page" CTA + StatusActions gated on `org_admin`. |
| `/campaigns/[id]/edit` | `app/(app)/campaigns/[id]/edit/page.tsx:30` | `requireAuth()` | Form unconditionally rendered. **Gap.** |
| `/campaigns/[id]/public-page` | `app/(app)/campaigns/[id]/public-page/page.tsx` | `requireOrgAdmin()` | Form is admin-only. |
| `/settings` | `app/(app)/settings/page.tsx:14` | `requireAuth()` (whole `/settings` subtree gated by layout below) | Tenant form & snapshot panel show their `canManage*` flag. |
| `/settings/*` (layout) | `app/(app)/settings/layout.tsx:21` | `requireAuth()` + `notFound()` if not `org_admin` | All `/settings/*` pages 404 for non-admins (anti-disclosure). |
| `/settings/members` | `app/(app)/settings/members/page.tsx` | inherited admin-only via layout | Invite + role-change actions only meaningful for admins. |
| `/settings/funds` | `app/(app)/settings/funds/page.tsx:29` | inherited admin-only via layout | "+ New" CTA gated on `canManageFunds`. |
| `/settings/funds/new` | `app/(app)/settings/funds/new/page.tsx:8` | inherited admin-only via layout | Form respects `canManageFunds`. |
| `/settings/funds/[id]/edit` | `app/(app)/settings/funds/[id]/edit/page.tsx:32` | inherited admin-only via layout | Form respects `canManageFunds`. |

### Field-level read/write — non-uniform fields

For most modules every field on the main entity inherits the route's
guard (read = `requireAuth`, write = `requireWrite` or `requireOrgAdmin`
per the verb). The exceptions worth flagging:

- **`campaigns.status`** — operational fields (`name`, `type`,
  `defaultCurrency`, `parentId`, `operationalCostCents`, `fundIds`) are
  write-tier; the `status` transition is admin-only and enforced in the
  PATCH handler with an explicit field-level check
  (`modules/campaigns/routes.ts:296-302`). Already correct.
- **`tenants.baseCurrency` / `tenants.defaultLocale`** — the entire
  tenant settings entity is admin-only via
  `requireSuperAdminOrOwnOrgAdmin`; no per-field exceptions are needed.
- **`donations.amountCents` / `donations.currency`** — viewers
  legitimately need to see donation amounts (dashboard KPIs, donor
  cards, campaign ROI). Treating amounts as a special-category field
  has no operational use case in an NPO context — donor relationship
  visibility is a baseline. Inheriting the route guard is correct.
  (Future "finance-only" view is the kind of signal that would justify
  revisiting the role count — see §C.5.)
- **`constituents.email` / `constituents.phone`** — personal data of
  donors / volunteers / beneficiaries. Visible to every authenticated
  role today; this matches the PIA's "donor relationship management"
  lawful basis (Art. 6(1)(f) legitimate interest). The viewer role
  should not be able to **export** PII at scale — this is enforced at
  the missing-export-route level (no `GET /v1/constituents/export`
  exists yet; when it does, it should be `requireOrgAdmin` per the
  GDPR architect doc).
- **Audit metadata** (`auditLogs.actorUserId`, `actorRole`,
  `field_changes`, `ip_address`) — not exposed via any read endpoint
  beyond `GET /v1/audit`, which is admin-only. No field-level concern
  today.
- **`users.role` / `users.firstAdmin` / `users.provisionalUntil`** —
  visible on the caller's own `/users/me` (any role) and on
  `/users` (admin-only). The `firstAdmin` + `provisionalUntil` fields
  drive UI banners but carry no security-sensitive state. OK as-is.
- **`disputes.reason`** — written by tenant members (pseudonymous
  free-text); read only by `super_admin`. Already correct.

If a module isn't listed above, every field inherits its route's guard.

---

## Phase B — Target matrix

### Table B1 — API routes with target guard

| Module | Method + Path | Current | **Target** | Justification |
|---|---|---|---|---|
| admin | DELETE `/v1/admin/impersonation/:sessionId` | `requireSuperAdmin` | `requireSuperAdmin` | Platform-only operation; correct. |
| audit | GET `/v1/audit` | `requireOrgAdmin` | `requireOrgAdmin` | Audit log discloses actor IDs and field-level changes; admin-only is the documented baseline. |
| campaigns | GET `/v1/campaigns` | `requireAuth` | `requireAuth` | Campaign list is operational reference data every role needs. |
| campaigns | POST `/v1/campaigns` | `requireWrite` | `requireWrite` | Operational create — viewers blocked, staff at parity with admins. |
| campaigns | GET `/v1/campaigns/:id` | `requireAuth` | `requireAuth` | Read of a campaign; viewers see campaigns on the dashboard. |
| campaigns | PATCH `/v1/campaigns/:id` | `requireWrite` (+ `status` admin-gate) | `requireWrite` (+ `status` admin-gate) | Field-level admin gate already correct. |
| campaigns | GET `/v1/campaigns/:id/funds` | `requireAuth` | `requireAuth` | Read; informational. |
| campaigns | POST `/v1/campaigns/:id/close` | `requireOrgAdmin` | `requireOrgAdmin` | Status transition = admin-only. |
| campaigns | GET `/v1/campaigns/:id/stats` | `requireAuth` | `requireAuth` | KPI read. |
| campaigns | GET `/v1/campaigns/:id/roi` | `requireAuth` | `requireAuth` | KPI read. |
| campaigns | POST `/v1/campaigns/:id/documents` | `requireOrgAdmin` | `requireOrgAdmin` | Bulk doc generation has cost + privacy impact. |
| constituents | GET `/v1/constituents` | `requireAuth` | `requireAuth` | List read. |
| constituents | GET `/v1/constituents/:id` | `requireAuth` | `requireAuth` | Detail read. |
| constituents | GET `/v1/constituents/duplicates/search` | `requireWrite` (this PR) | `requireWrite` | Pre-flight to create — leaks PII match if open to viewers. |
| constituents | POST `/v1/constituents` | `requireWrite` (this PR) | `requireWrite` | Original symptom — viewers must not create. |
| constituents | PUT `/v1/constituents/:id` | `requireWrite` (this PR) | `requireWrite` | Operational edit. |
| constituents | DELETE `/v1/constituents/:id` | `requireOrgAdmin` | `requireOrgAdmin` | Soft-delete = destructive on a record everyone else relies on. |
| constituents | POST `/v1/constituents/:id/merge` | `requireOrgAdmin` | `requireOrgAdmin` | Irreversible (modulo merge-history); admin-only. |
| disputes | POST `/v1/tenants/:orgId/admin-dispute` | `requireAuth` (+ same-tenant) | `requireAuth` (+ same-tenant) | Any tenant member can dispute their first-admin; correct. |
| disputes | GET `/v1/admin/disputes` | `requireSuperAdmin` | `requireSuperAdmin` | Platform triage queue. |
| disputes | GET `/v1/admin/disputes/:id` | `requireSuperAdmin` | `requireSuperAdmin` | Platform-only. |
| disputes | PATCH `/v1/admin/disputes/:id` | `requireSuperAdmin` | `requireSuperAdmin` | Platform-only. |
| donations | GET `/v1/donations` | `requireAuth` | `requireAuth` | Read; viewers need amounts for dashboards. |
| donations | GET `/v1/donations/:id` | `requireAuth` | `requireAuth` | Read with allocations. |
| donations | POST `/v1/donations` | `requireAuth` | **`requireWrite`** | Recording a donation is the canonical write — viewers must not. |
| donations | PATCH `/v1/donations/:id` | `requireAuth` | **`requireWrite`** | Edit alters financial history. |
| donations | DELETE `/v1/donations/:id` | `requireAuth` | **`requireOrgAdmin`** | Erasing a donation has GDPR + audit + accounting impact. |
| donations | GET `/v1/donations/:id/receipt` | `requireAuth` | `requireAuth` | Read of presigned URL — same trust level as donation detail. |
| funds | GET `/v1/funds` | `requireAuth` | `requireAuth` | Read of fund directory. |
| funds | POST `/v1/funds` | `requireOrgAdmin` | `requireOrgAdmin` | Defines the chart of accounts; admin-only is correct (a fund underpins every restricted donation, so it's settings-tier). |
| funds | GET `/v1/funds/:id` | `requireAuth` | `requireAuth` | Read. |
| funds | PATCH `/v1/funds/:id` | `requireOrgAdmin` | `requireOrgAdmin` | Same as create. |
| funds | DELETE `/v1/funds/:id` | `requireOrgAdmin` | `requireOrgAdmin` | Same. |
| health | GET `/healthz` | none | none | Liveness must be unauthenticated for k8s probes. |
| health | GET `/readyz` | none | none | Readiness must be unauthenticated. |
| invitations | POST `/v1/invitations` | `requireOrgAdmin` | `requireOrgAdmin` | Member management. |
| invitations | GET `/v1/invitations` | `requireOrgAdmin` | `requireOrgAdmin` | Member management. |
| invitations | POST `/v1/invitations/:id/resend` | `requireOrgAdmin` | `requireOrgAdmin` | Member management. |
| invitations | DELETE `/v1/invitations/:id` | `requireOrgAdmin` | `requireOrgAdmin` | Member management. |
| invitations | GET `/v1/invitations/:token/probe` | none | none | Token IS the credential; rate-limited. |
| invitations | POST `/v1/invitations/:token/accept` | none | none | Token IS the credential; rate-limited. |
| payments | POST `/v1/admin/stripe-connect` | `requireOrgAdmin` | `requireOrgAdmin` | Onboards the tenant's payment account; admin-only. |
| payments | POST `/v1/donations/stripe-webhook` | none (signature) | none (signature) | Stripe signature is the credential. |
| pledges | POST `/v1/pledges` | `requireAuth` | **`requireWrite`** | Pledge creation = operational write; viewers must not. |
| pledges | GET `/v1/pledges/:id/installments` | `requireAuth` | `requireAuth` | Read. |
| public | GET `/v1/campaigns/:id/public-page` | `requireOrgAdmin` | `requireOrgAdmin` | Admin config of the donor-facing page. |
| public | GET `/v1/public/campaigns/:id/page` | none | none | Public donor-facing payload — published campaigns only. |
| public | GET `/v1/public/qr/:code` | none | none | Public QR resolution; rate-limited. |
| public | POST `/v1/public/campaigns/:id/donate` | none | none | Donor pays without an account; rate-limited. |
| public | PUT `/v1/campaigns/:id/public-page` | `requireOrgAdmin` | `requireOrgAdmin` | Admin upsert of the public page (brand, goal, copy). |
| reports | GET `/v1/reports/lybunt` | `requireOrgAdmin` | `requireOrgAdmin` | Lifecycle analytics expose donor-recency profiles; admin-tier is correct, plus the data drives major-gift fundraising decisions admins own. |
| reports | GET `/v1/reports/sybunt` | `requireOrgAdmin` | `requireOrgAdmin` | Same rationale. |
| session | GET `/v1/users/me/organizations` | `requireAuth` | `requireAuth` | Caller's own membership cards. |
| session | POST `/v1/session/switch-org` | `requireAuth` (+ no-impersonation) | `requireAuth` (+ no-impersonation) | Caller switches their own session. |
| signup | POST `/v1/public/signup` | none | none | Public + CAPTCHA; rate-limited. |
| signup | POST `/v1/public/signup/resend` | none | none | Public + per-email rate-limit. |
| signup | POST `/v1/public/signup/verify` | none | none | Token IS the credential. |
| signup | GET `/v1/public/tenants/lookup` | none | none | Login-form discovery; rate-limited. |
| tenant-admin | every `/v1/superadmin/*` route | `requireSuperAdmin` | `requireSuperAdmin` | Platform admin domain. |
| tenant-admin | `/v1/tenants/:orgId/domains*` (3 routes) | `requireSuperAdminOrOwnOrgAdmin` | `requireSuperAdminOrOwnOrgAdmin` | Tenant-scoped admin operation. |
| tenants | GET `/v1/admin/tenants/:orgId` | `requireSuperAdminOrOwnOrgAdmin` | `requireSuperAdminOrOwnOrgAdmin` | Tenant settings view. |
| tenants | PUT `/v1/admin/tenants/:orgId` | `requireSuperAdminOrOwnOrgAdmin` | `requireSuperAdminOrOwnOrgAdmin` | Tenant settings update. |
| tenants | GET `/v1/admin/tenants/:orgId/snapshot` | `requireSuperAdminOrOwnOrgAdmin` | `requireSuperAdminOrOwnOrgAdmin` | Bulk PII export — admin-only. |
| tenants | POST `/v1/tenants` | `requireAdminSecret` | `requireAdminSecret` | Control-plane bootstrap. |
| tenants | GET `/v1/tenants` | `requireAdminSecret` | `requireAdminSecret` | Control-plane. |
| tenants | GET `/v1/tenants/:id` | `requireAdminSecret` | `requireAdminSecret` | Control-plane. |
| tenants | DELETE `/v1/tenants/:id` | `requireAdminSecret` | `requireAdminSecret` | Control-plane. |
| users | GET `/v1/users/me` | `requireAuth` | `requireAuth` | Caller's own profile. |
| users | PATCH `/v1/users/me` | `requireAuth` | `requireAuth` | Caller's own preferences. |
| users | GET `/v1/users` | `requireOrgAdmin` | `requireOrgAdmin` | Member management. |
| users | POST `/v1/users` | `requireOrgAdmin` | `requireOrgAdmin` | Member management (legacy provisioning path). |
| users | PATCH `/v1/users/:id/role` | `requireOrgAdmin` | `requireOrgAdmin` | Member management. |
| users | DELETE `/v1/users/:id` | `requireOrgAdmin` | `requireOrgAdmin` | Member management. |

### Table B2 — Frontend `(app)` pages with target guard

| Route | Current | **Target** | Justification |
|---|---|---|---|
| `/dashboard` | `requireAuth()` | `requireAuth()` | Read-only widgets; every role lands here. |
| `/profile` | `requireAuth()` | `requireAuth()` | Caller's own preferences. |
| `/constituents` | `requireAuth()` (CTAs gated) | `requireAuth()` + hide "+ New" for `viewer` (this PR) | Match API: viewers can read, only `write` roles can create. |
| `/constituents/new` | `requirePermission("write")` (this PR) | `requirePermission("write")` | Creates a constituent — write-tier. |
| `/constituents/[id]` | `requireAuth()` (admin actions gated) | `requireAuth()` + hide "Edit" for `viewer` (this PR) | Edit must reflect API write-gate. |
| `/constituents/[id]/edit` | `requirePermission("write")` (this PR) | `requirePermission("write")` | Edit form. |
| `/donations` | `requireAuth()` | `requireAuth()` + hide "+ New" for `viewer` | Match the (forthcoming) API write-gate on `POST /v1/donations`. |
| `/donations/new` | `requireAuth()` | **`requirePermission("write")`** | Viewer reaches the form today — would 403 on submit once API is fixed; hide entirely to avoid dead-end UX. |
| `/donations/[id]` | `requireAuth()` | `requireAuth()` + hide "Edit" / "Delete" buttons for `viewer` (delete additionally only for `org_admin`) | Match API write/admin gates. |
| `/donations/[id]/edit` | `requireAuth()` | **`requirePermission("write")`** | Edit form. |
| `/campaigns` | `requireAuth()` (admin actions gated) | `requireAuth()` + hide "+ New" for `viewer` | Match API write-gate on `POST /v1/campaigns`. |
| `/campaigns/new` | `requireAuth()` | **`requirePermission("write")`** | Mirror API. |
| `/campaigns/[id]` | `requireAuth()` (some admin actions gated) | `requireAuth()` + hide "Edit" for `viewer` | The Edit button currently shows for every role — but API requires `write`. Viewers see a dead-end button. |
| `/campaigns/[id]/edit` | `requireAuth()` | **`requirePermission("write")`** | Mirror API. |
| `/campaigns/[id]/public-page` | `requireOrgAdmin()` | `requireOrgAdmin()` | Admin config of the public page. |
| `/settings` | `requireAuth()` (gated by `(app)/settings/layout.tsx` to `org_admin`) | `requireAuth()` (layout-enforced admin via `notFound()`) | Layout already correct. |
| `/settings/*` (layout) | `requireAuth()` + `notFound()` if not `org_admin` | same | Anti-disclosure — keep. |
| `/settings/members` | inherited admin-only | inherited admin-only | OK. |
| `/settings/funds` | inherited admin-only | inherited admin-only | OK. |
| `/settings/funds/new` | inherited admin-only | inherited admin-only | OK. |
| `/settings/funds/[id]/edit` | inherited admin-only | inherited admin-only | OK. |

---

## Phase C — Gap report

### C.1 — Gap summary (Current ≠ Target)

Severity legend repeated for clarity:

- **High** — viewer or unauthenticated caller can perform a write or
  destructive action they shouldn't.
- **Medium** — a write that is gated but to a less-strict guard than it
  should be (e.g. `requireWrite` where `requireOrgAdmin` is correct).
- **Low** — read-leak of data a role shouldn't see, or guard that's too
  strict (over-blocking) and harms UX without security benefit.

#### API gaps

| # | Module | Row | Current → Target | Severity | Rationale |
|---|---|---|---|---|---|
| API-1 | constituents | `POST /v1/constituents` | `requireAuth` → `requireWrite` | **High** | Original symptom of issue #162. **Fixed in this PR.** |
| API-2 | constituents | `PUT /v1/constituents/:id` | `requireAuth` → `requireWrite` | **High** | Viewer can update any constituent. **Fixed in this PR.** |
| API-3 | constituents | `GET /v1/constituents/duplicates/search` | `requireAuth` → `requireWrite` | Medium | Viewer can fuzzy-search PII pre-flight. **Fixed in this PR.** |
| API-4 | donations | `POST /v1/donations` | `requireAuth` → `requireWrite` | **High** | Viewer can record manual donations — financial write. |
| API-5 | donations | `PATCH /v1/donations/:id` | `requireAuth` → `requireWrite` | **High** | Viewer can edit financial history. |
| API-6 | donations | `DELETE /v1/donations/:id` | `requireAuth` → `requireOrgAdmin` | **High** | Viewer (and any non-admin) can delete donations — accounting + audit + GDPR risk. |
| API-7 | pledges | `POST /v1/pledges` | `requireAuth` → `requireWrite` | **High** | Viewer can create recurring-giving commitments. |

#### Frontend gaps

| # | Route | Current → Target | Severity | Rationale |
|---|---|---|---|---|
| FE-1 | `/constituents` (list) | hide "+ New" for `viewer` | Low | Dead-end CTA. **Fixed in this PR.** |
| FE-2 | `/constituents/new` | `requireAuth()` → `requirePermission("write")` | Medium | Viewer reached the form. **Fixed in this PR.** |
| FE-3 | `/constituents/[id]` | hide "Edit" for `viewer` | Low | Dead-end CTA. **Fixed in this PR.** |
| FE-4 | `/constituents/[id]/edit` | `requireAuth()` → `requirePermission("write")` | Medium | Viewer reached the form. **Fixed in this PR.** |
| FE-5 | `/donations` (list) | hide "+ New" for `viewer` | Low | Dead-end CTA once API-4 lands. |
| FE-6 | `/donations/new` | `requireAuth()` → `requirePermission("write")` | Medium | Viewer reaches the form; submit will 403 once API-4 lands. |
| FE-7 | `/donations/[id]` | hide "Edit"+"Delete" for `viewer` (Delete: hide unless `org_admin` once API-6 lands) | Low | Dead-end buttons. |
| FE-8 | `/donations/[id]/edit` | `requireAuth()` → `requirePermission("write")` | Medium | Viewer reaches the form. |
| FE-9 | `/campaigns` (list) | hide "+ New" for `viewer` | Low | Dead-end CTA — `POST /v1/campaigns` already requires `requireWrite` (so submit would 403 today). |
| FE-10 | `/campaigns/new` | `requireAuth()` → `requirePermission("write")` | Medium | Viewer reaches the form even though API rejects submission. |
| FE-11 | `/campaigns/[id]` | hide "Edit" for `viewer` | Low | Dead-end CTA. |
| FE-12 | `/campaigns/[id]/edit` | `requireAuth()` → `requirePermission("write")` | Medium | Viewer reaches the form even though API rejects PATCH. |

Total gaps: **7 API rows + 12 frontend rows = 19**, of which **7 are
already fixed in this PR** (API-1 through -3, FE-1 through -4).

### C.2 — Severity breakdown

| Severity | Count | Already fixed in this PR | Outstanding |
|---|---|---|---|
| High | 6 | 2 | 4 |
| Medium | 8 | 2 | 6 |
| Low | 5 | 3 | 2 (the donations FE list/detail rows track API-4..6) |

The four outstanding **High** items (API-4, -5, -6, -7) are all
financial-write endpoints that today permit `viewer` to record / edit /
delete donations and create pledges. These are the priority for the
follow-up issues below.

### C.3 — Follow-up issue plan

(Modules where the constituents fix already shipped in this PR are
intentionally omitted; the orchestrator will create the issues below
via `gh issue create`. One issue per module — multiple rows roll up
into a single PR.)

- **Donations RBAC tightening**
  *Title*: `feat(security): tighten donations RBAC — viewer cannot
  write or delete donations`
  *Body*: API-4/-5/-6 plus FE-5/-6/-7/-8. Writes go to `requireWrite`,
  delete to `requireOrgAdmin`; web pages mirror via `requirePermission`
  + hide affordances. Includes integration tests asserting 403 for
  `viewer` on each verb.
  *Rows covered*: API-4, API-5, API-6, FE-5, FE-6, FE-7, FE-8.

- **Pledges RBAC tightening**
  *Title*: `feat(security): pledges create requires write tier`
  *Body*: API-7 — `POST /v1/pledges` lifts to `requireWrite`. No web
  page exists today, so this is API-only. Integration test:
  `viewer → 403`, `user → 201`. Note that `GET /v1/pledges/:id/installments`
  stays at `requireAuth` (read).
  *Rows covered*: API-7.

- **Campaigns frontend permission alignment**
  *Title*: `feat(security): hide write affordances from viewer on
  campaigns pages`
  *Body*: API guards on campaigns are already correct; the gap is purely
  in the web layer. Lift `/campaigns/new` and `/campaigns/[id]/edit`
  to `requirePermission("write")`, gate "+ New" CTA on the campaigns
  list, and hide the Edit button on the campaign detail page for
  `viewer`. No API change.
  *Rows covered*: FE-9, FE-10, FE-11, FE-12.

(Constituents has no follow-up issue — its 7 rows are all in this PR.)

### C.4 — Frontend "two visual shapes" recommendation

The issue's framing ("read-optimized for viewer vs edit-capable for
user/org_admin") is the right long-term shape, but it is **not the
right scope for this audit-PR cycle**. Here is why:

- The current pattern — render the same detail page for everyone, hide
  edit affordances behind role checks (`canManageAdminActions`,
  `canWrite`) — is correct from a security standpoint. The viewer
  doesn't see buttons they can't use; clicking nothing leads to nothing.
- A genuine "two visual shapes" rework would mean different layouts,
  different typography, different IA per role. That is a **design
  system** investment (mockups, component variants, copy decks per
  role), not an RBAC fix. Doing it as part of the audit's follow-up
  issues would couple security work to a UX redesign and slow down
  the security tightening.
- The pragmatic plan: **ship the affordance-gating gaps now** (FE-1
  through -12 — most already in this PR) so that no role sees a button
  it can't use, and **defer the read-optimised viewer layout to a
  separate design issue** that the design-architect agent owns.

In short: hide CTAs and gate routes today; redesign the viewer
detail-view shape later, as a deliberate UX project. The `viewer`
experience is acceptable as-is — it's just a normal detail page with
fewer buttons.

### C.5 — The 3-role question

**Three application roles (`org_admin`, `user`, `viewer`) plus
`super_admin` is the right call today.** The matrix above expresses
every meaningful capability the platform exposes today using exactly
those three roles plus the existing five guard primitives. No row in
the target matrix required a 4th role to express its rule, and no
gap in §C.1 stems from missing role granularity — every gap is a
misapplied existing guard.

The aspirational 10-role model in
[`docs/06-security-compliance.md`](../06-security-compliance.md#L61)
(`fundraising_manager`, `program_manager`, `volunteer_coordinator`,
`finance_viewer`, `data_entry`, `read_only`, etc.) is a longer-term
target tied to features that don't exist yet in the modular monolith
(case notes, beneficiary programs, volunteer management, finance
sub-views). The doc is aspirational; the code is the contract for now.

**Future signal that would justify a 4th role**: when the Givernance
roadmap ships either (a) the **case-notes module** with row-level
"author-only" reads (would need `program_manager` distinct from
`user`), or (b) the **finance reporting** view that masks PII while
exposing aggregated amounts (would need `finance_viewer` distinct from
`viewer`). Until either of those lands, adding a role would add
operator-onboarding friction with zero security gain — and the
current 3-role model maps cleanly to `org_admin / user / viewer`
which every operator already understands.

If a 4th role becomes warranted, file it as a separate design issue
(per the audit's own scope rules) so the trade-offs (DB migration,
JWT claim shape, UI permission picker, role-mapper config) get a
focused review instead of being slipped in as a security fix.

---

## Appendix — How to keep this matrix honest

When adding a new route or page, the author should:

1. Pick the guard from the cheat-sheet at the top of this document. If
   none of the 5 fits, raise it in the PR description before inventing
   a new one.
2. Add the row to Table B1 / B2 above and resolve the "Current →
   Target" delta in the same PR.
3. For any route that introduces field-level non-uniform read/write,
   add a bullet in the "Field-level" section.
4. Re-run this audit (file path: `docs/security/rbac-audit-YYYY-MM-DD.md`)
   roughly annually, or after any net-new module.

The two source files that ground every row above are:

- API guards: [`packages/api/src/lib/guards.ts`](../../packages/api/src/lib/guards.ts)
- Frontend permissions: [`packages/web/src/lib/auth/guards.ts`](../../packages/web/src/lib/auth/guards.ts)

A regression here is a regression in the security boundary — both
files are short and stable, both should be reviewed by a second pair
of eyes whenever they change.
