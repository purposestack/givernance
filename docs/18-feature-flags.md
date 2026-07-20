# 18 — Feature Flag Strategy

> **Status**: Phase 2 backend shipped (PR #366 — tenant overrides + scope + public projection filter); Phase 2 frontend lands incrementally on the same PR. Plan-gating remains as a future-phase target.
> **Owner**: Feature Flag Engineer agent (`.claude/agents/feature-flag-engineer.md`)
> **Related**: `02-reference-architecture.md`, `03-data-model.md`, `04-business-capabilities.md`, `06-security-compliance.md`, `07-delivery-roadmap.md`

## 0. What's actually shipped (Phase 1 MVP + Phase 2 backend)

Phase 1 (PR #352) shipped the global-flag subset; Phase 2 (PR #366 / Epic #365) added tenant overrides, scope-based gating, and the public-projection filter. The table below is the live status as of PR #366 (status banner at the top of [`.claude/agents/feature-flag-engineer.md`](../.claude/agents/feature-flag-engineer.md) carries the same summary for agent briefings):

> **Retired flags (issue #493).** Five validated flags were retired — their features are now permanently part of the product, with the gating code deleted (no `requireFlag`, no worker `isFlagEnabled`, no SSR `xEnabled`) and their seed rows dropped by migration `0082`: `admin.feature_flags_phase2`, `admin.finance_dashboard`, `admin.impersonation_replicate`, `communication.notifications_center`, `productivity.command_palette`. The per-organisation flag-administration tooling that `admin.feature_flags_phase2` once gated **stays** — only its own gate was removed; the remaining flags still use it. See § 8 "Flag Lifecycle → REMOVED". The flags still in active rollout are `communication.bulk_email`, `donation.public_page_styles`, `constituents.bulk_import`, `advanced_filters`, `campaign.postal_merged_pdf` — joined by the three per-domain customization kill-switches `constituents.custom_fields`, `donations.custom_fields`, `campaigns.custom_fields` (Epic #539, seeded by `0089`: default-off, `scope='tenant'`, `tenant_override_allowed=false` for a staff-enabled rollout, `public=true` so SSR can project the enabled state; see [35-customization.md](35-customization.md)).

| Surface | Status | Notes |
|---|---|---|
| `feature_flags` table | ✅ shipped (`0047` + `0051`) | Phase 2 added `scope` (enum platform/tenant), `tenant_override_allowed` boolean, `public` boolean. Partial index on `WHERE public = TRUE` for the hot projection path. |
| `tenant_flag_overrides` table | ✅ shipped (`0051`) | Per-org overrides. RLS forced via `tenant_id = app_current_organization_id()`. `UNIQUE (tenant_id, flag_key)`. `reason` free-text + `set_by SET NULL ON DELETE`. `expires_at` reserved (UI deferred). |
| `FEATURE_FLAG_REGISTRY` const (`packages/shared/src/constants/feature-flags.ts`) | ✅ shipped | Typed `FeatureFlagKey` union; entries declare `scope` + `tenantOverrideAllowed` + `public`. Live keys after issue #493: `communication.bulk_email`, `donation.public_page_styles`, `constituents.bulk_import`, `advanced_filters`, `campaign.postal_merged_pdf`, plus the Epic #539 trio `constituents.custom_fields` / `donations.custom_fields` / `campaigns.custom_fields` (all `scope='tenant'`). `constituents.bulk_import` was the first key with `tenant_override_allowed=true`, driving the first real row on the org-admin `/settings/feature-flags` page — Epic #373, PR #385. |
| `flagService.isEnabled(key, ctx?)` + Redis cache | ✅ shipped (Phase 2) | `ctx.orgId` activates tenant overrides for `scope='tenant'` flags. Caches: `flags:global:v2` (Map<key, {enabled, scope}>) + per-tenant `flags:tenant:{orgId}:v1`. TTL 60 s. v2 because Phase-1 shape was `Record<key, boolean>` and the evaluator now needs `scope`. |
| Precedence algorithm | ✅ shipped (Phase 2) | unknown key → false; `scope='platform'` → platform default (overrides ignored even if rows exist); `scope='tenant'` + orgId → override row if present else default; `scope='tenant'` + no orgId → default (worker / platform path). Section 5 below is the live spec. |
| `requireFlag(key)` preHandler | ✅ shipped | 404 on disabled, runs FIRST in the preHandler chain so a scanner can't enumerate role requirements. Now passes `request.auth.orgId` so tenant-scoped flags evaluate against the caller's org (backward-compatible: public/unauthenticated routes get a null orgId and fall back to platform default, identical to the Phase-1 no-context call). |
| Worker-side `isFlagEnabled(key)` | ✅ shipped | `packages/worker/src/lib/flags.ts` — defence-in-depth at job pickup. Workers operate without an `orgId` context (platform path) — fine for `scope='platform'` flags, which are the only thing workers gate on today. |
| `GET /v1/admin/feature-flags` | ✅ shipped | Super-admin global view. Response carries `overrideStats` per row (count of tenants overriding to true / false) for tenant-scoped flags; `null` for platform-scoped flags that never carry overrides so the JSON shape stays stable. |
| `PATCH /v1/admin/feature-flags/:key` | ✅ shipped | Super-admin platform-default flip. Unchanged from Phase 1. |
| `GET /v1/admin/tenants/:tenantId/feature-flags` | ✅ shipped (Phase 2) | Super-admin tenant-detail tab. Returns each flag with platform default + effective value + override row (if any). `scope='platform'` flags surface as read-only context. |
| `PUT /v1/admin/tenants/:tenantId/feature-flags/:key` | ✅ shipped (Phase 2) | Super-admin upsert override. 404 on missing flag (anti-disclosure), 422 on `scope='platform'` attempt (operator picked the wrong tool). Idempotent — re-PUT with same payload refreshes `set_by` / `reason` / `updated_at`. |
| `DELETE /v1/admin/tenants/:tenantId/feature-flags/:key` | ✅ shipped (Phase 2) | Super-admin remove override (revert to platform default). 204 regardless of prior state. |
| `GET /v1/org/feature-flags` | ✅ shipped (Phase 2) | Org-admin self-service list. Filtered to `scope='tenant' AND tenant_override_allowed=true`. As of PR #385 the registry has one such row (`constituents.bulk_import`); the page now renders that toggle instead of the original empty state. |
| `PATCH /v1/org/feature-flags/:key` | ✅ shipped (Phase 2) | Org-admin self-service toggle. 404 (anti-disclosure) for every rejection — platform-scoped flags, admin-gated flags, missing keys all look identical to the caller. |
| `GET /v1/feature-flags` (public projection) | ✅ shipped (Phase 2) | Now filtered by `public=true` — unreleased flag names no longer leak via DevTools. Evaluator overlays the caller's tenant overrides on each value. Resolves the public-projection caveat from prior § 0. |
| Audit trail | ✅ shipped | The existing `audit-plugin` (`packages/api/src/plugins/audit.ts`) auto-records every mutating request including the new override CRUD. `action` (e.g. `PUT:/v1/admin/tenants/:tenantId/feature-flags/:key`), `org_id`, `actor_id`, `resource_type`, `resource_id`, impersonation context — all captured. Satisfies § 4.3 with zero new audit code. |
| `admin.feature_flags_phase2` self-flag | ♻️ retired (issue #493) | The Phase-2 tooling is now always reachable; only the self-flag gate was removed. The override endpoints, the per-tenant "Feature flags" tab, the org-admin `/settings/feature-flags` page, and `overrideStats` all stay — the remaining flags rely on them. Seed row dropped by migration `0082`. |
| Back Office page `/admin/feature-flags` | ✅ shipped Phase 1; 🚧 Phase 2 tenant-override column lands on PR #366 | Existing toggle UI for platform defaults. Tenant-override count column + drill-down side-panel land on this PR. |
| Super-admin "Feature flags" tab on `/admin/tenants/[id]` | 🚧 in progress (PR #366) | Lands on this PR. |
| Org-admin `/settings/feature-flags` page | 🚧 in progress (PR #366) | Lands on this PR. |
| Plan-gating (`plan_gate` column) | ❌ deferred | A separate Epic tied to subscription/billing infra. Operator-controlled flags (Epic #365) and billing-controlled entitlements are different concerns; bundling them here would have coupled this Epic to billing work that hasn't been scoped. |
| React `<FlagProvider>` + `useFlags()` hook | ❌ deferred | Each consumer page passes the prop down for now. |
| Auto-expire worker for `tenant_flag_overrides.expires_at` | ❌ deferred | Column exists; no worker enforces it. UI for setting expiry deferred. |

Adding a new flag (Phase 2 procedure):
1. Append the key to `FEATURE_FLAG_KEYS` in `packages/shared/src/constants/feature-flags.ts` AND to `FEATURE_FLAG_REGISTRY` with its `defaultEnabled` + `label` + `description` + **`scope`** + **`tenantOverrideAllowed`** + **`public`**. Scope decisions: `platform` for super-admin-only features (DKIM-blocked, internal tools, billing-coupled); `tenant` for features each NPO genuinely chooses. Public decision: `true` for any flag whose key needs to appear in the tenant-side public projection (e.g. the SSR layer reads it to render conditional UI); `false` for unreleased keys whose name shouldn't leak via DevTools.
2. Write a migration that `INSERT … ON CONFLICT (key) DO NOTHING` for the key with matching `default_value` + `label` + `description` + `scope` + `tenant_override_allowed` + `public`. The integration parity test enforces label + description parity between `FEATURE_FLAG_REGISTRY` and the seeded DB row — drift fails CI.
3. Wire `requireFlag(FEATURE_FLAG_KEYS.YOUR_KEY)` on the gated routes.
4. If the worker has a matching processor, add an `isFlagEnabled(...)` check at job pickup (defence-in-depth).
5. If the UI surface is conditional, SSR-fetch `/v1/feature-flags` and pass `xEnabled` as a prop into the consumer component. Hide every dependent surface (buttons, columns, panels) on the consumer page — not just the action button. A dead selection column is operator-confusing UX.

### Text-field convention (label / description)

The `label` and `description` columns are **operator-facing**. Write them in plain language; the audience is a non-technical Back Office user, not an engineer:

- **`label`** — a short friendly title (e.g. "Bulk emails to constituents"). 1-6 words. Acts as the row heading in the UI. Avoid the dotted-namespace key (`communication.bulk_email`) — the key still renders as a small monospaced subtitle so engineers reading audit logs can correlate, but operators see the label first.
- **`description`** — one or two sentences explaining **what the feature does for the operator**. No engineering jargon (DKIM, SPF, DMARC, BullMQ, etc.), no RFC references, no incident IDs, no GitHub issue numbers.

Engineering rationale (why a flag is off by default, which incident motivated it, what infra prerequisites are blocking enablement) lives in **code comments above the `FEATURE_FLAG_KEYS` entry**. That keeps the operator UI clean while leaving full context for anyone reading the code.

Why DB-stored text (vs i18n-keyed): the registry is small (<10 keys foreseeable), and storing the strings in the DB lets a new flag ship without touching every locale's `messages/*.json`. Trade-off: operator-facing text is English-only for now. When the registry grows or the Back Office becomes multilingual, the migration path is straightforward — add `messages.feature_flags.<key>.label` / `.description` keys and have the API resolve them via `getTranslations` before returning the row.

### Audit + observability notes

- **Audit trail.** Every super-admin flag toggle (`PATCH /v1/admin/feature-flags/:key`) is recorded in `audit_logs` by the existing audit plugin. `org_id` on the row reflects the JWT's `org_id` claim — which Keycloak emits even for super-admin sessions (the verifier rejects tokens without one). For platform-scoped actions like flag toggles, this is whatever tenant the super-admin's session is currently scoped to (delegation: the target tenant; non-delegation: the Keycloak platform org). Routing platform-scoped audits to the `__platform__` sentinel tenant for cleaner SIEM filtering is a separate cross-cutting follow-up — out of scope for this PR.
- **No outbox event.** Flipping a flag does NOT emit an `outbox_events` row. The worker reads PG directly (no cache) so it observes the new value on the next job pickup; the frontend reads `/v1/feature-flags` on every SSR render. If a future flag needs realtime worker invalidation (cancel in-flight jobs the moment the flag flips), that's the case for adding `feature_flag.toggled` to the outbox.
- **Public projection caveat.** `GET /v1/feature-flags` returns every registered flag (key + enabled only) to every authenticated caller. That's fine for the current single-flag registry; once experimental / unreleased flags land, consider adding a `public boolean` column and filtering to `public = true` in this endpoint so unreleased feature *names* don't leak via the tenant API.
- **Cardinality.** The `requireFlag` 404 log line carries `path = routeOptions.url` (the route template, not the raw URL with query/UUIDs) so a misbehaving SPA can't blow up Loki's index. Add a Cockpit Grafana alert on `level=info AND event=flag.route_gated` count over time if you want to detect scanner enumeration.

### Emergency rollback

If the Back Office page is unavailable and a flag needs to come down NOW, see `docs/runbooks/feature-flag-rollback.md` — the canonical procedure is `UPDATE feature_flags SET enabled = false WHERE key = ?;` + `redis-cli DEL flags:global`.

### How to verify the per-organisation override surfaces locally

The flag-administration tooling is always reachable (the `admin.feature_flags_phase2` self-flag that once gated it was retired in issue #493). On a fresh local checkout the surfaces are present immediately: the **Feature flags** tab on `/admin/tenants/[id]`, the `/settings/feature-flags` org-admin page, and the Feature flags entry in the org-admin settings nav strip.

To see the override UI end-to-end:

1. **Apply migrations** on the local DB:
   ```bash
   DATABASE_URL="postgresql://givernance:givernance_dev@localhost:5432/givernance" \
     pnpm --filter @givernance/api run db:migrate
   ```

2. **Verify the seed** (the retired keys are gone after migration `0082`):
   ```bash
   psql "postgresql://givernance:givernance_dev@localhost:5432/givernance" \
     -c "SELECT key, enabled, scope, tenant_override_allowed, public FROM feature_flags;"
   ```
   The live keys are `communication.bulk_email`, `donation.public_page_styles`, `constituents.bulk_import`, `advanced_filters`, `campaign.postal_merged_pdf` — all `scope='tenant'`, all `enabled=false` at first deploy.

3. **Reload + observe**:
   - **Super-admin** `/admin/feature-flags` — `Per-organisation` scope badges per row + plain-language scope hint; "Organisations overriding the default" line renders (zeros until overrides exist).
   - **Super-admin** `/admin/tenants/[id]` — the **Feature flags** tab to the right of Audit.
   - **Org-admin** `/settings/feature-flags` — page renders with a row for `constituents.bulk_import` (scope='tenant', override-allowed). Toggling it on activates the "Bulk import" button on the constituents page.

4. **To see the real override controls** (the per-tenant toggle on the super-admin tenant tab + the toggle row on the org-admin page), insert a demo flag that's actually tenant-overridable. This is **local-only**; do not seed it in a shipped migration:
   ```bash
   psql "postgresql://givernance:givernance_dev@localhost:5432/givernance" <<'SQL'
   INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
   VALUES (
     'demo.notification_digest',
     false,
     'Notification digest',
     'Sends a weekly summary of donations and grant deadlines to each user.',
     'tenant',
     true,
     true
   );
   SQL
   redis-cli DEL flags:global:v2
   ```
   After reload, the `Notification digest` row appears in both the super-admin tenant tab (with **Turn on for this organisation** / **Use platform default**) and the org-admin self-service page (with **Turn on** / **Turn off** / **Use the default**).

   To clean up: `DELETE FROM tenant_flag_overrides WHERE flag_key='demo.notification_digest'; DELETE FROM feature_flags WHERE key='demo.notification_digest'; redis-cli FLUSHDB`.

## 1. Goals

The feature flag strategy must enable:

- **Safe test-tenant validation** — any new feature can be activated for a single org before general availability, with zero code changes
- **Plan-based entitlement** — features automatically on/off based on subscription tier, without custom billing logic in route handlers
- **Emergency kill-switch** — disable a broken feature instantly across all tenants without a deploy
- **Gradual rollout** — go from 0% to 100% by enabling overrides incrementally
- **Clean removal** — flags have a defined lifecycle; they are never permanent unless they represent permanent plan gates

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Givernance API (Fastify 5)                       │
│                                                                           │
│  inbound request                                                          │
│       │                                                                   │
│       ▼                                                                   │
│  ┌─────────────────────────┐                                             │
│  │  requireFlag() preHandler│  ← flag off → 404 (silent denial)          │
│  └─────────────┬───────────┘                                             │
│                │ flag on                                                  │
│                ▼                                                          │
│         route handler / service                                          │
└────────────────┬────────────────────────────────────────────────────────┘
                 │
      ┌──────────▼────────────┐
      │  FlagService.isEnabled │
      │  (packages/shared)     │
      └──────────┬────────────┘
                 │
     ┌───────────┴────────────────┐
     │                            │
┌────▼────┐               ┌───────▼──────┐
│  Redis  │  cache miss   │  PostgreSQL  │
│  Cache  │ ──────────────│  (source of  │
│  TTL 60s│               │   truth)     │
└─────────┘               └──────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                       Next.js 16 (SSR + React)                           │
│                                                                           │
│  server component (layout/page)                                          │
│       │  getFlagsForTenant(tenantId) → flags map                         │
│       │                                                                   │
│       ├─ page gated → notFound() if flag off                             │
│       │                                                                   │
│       └─ <FlagProvider flags={flags}>                                    │
│               │                                                           │
│               └─ client component → const { isEnabled } = useFlags()     │
└─────────────────────────────────────────────────────────────────────────┘
```

## 3. Technology Choices

### 3.1 Flag Storage: PostgreSQL (source of truth)

The `feature_flags` table holds the platform registry. `tenant_flag_overrides` holds per-org exceptions. PostgreSQL is the authoritative store because:

- GDPR Art. 15 compliance: flag overrides per tenant must be included in data exports
- Audit trail: every override change is an `audit_logs` entry
- Admin UI: super_admin needs a queryable, structured store (not a config file)

### 3.2 Flag Cache: Redis (evaluation layer)

Every API request evaluates flags. PostgreSQL round-trips on every request are not acceptable. Redis provides:

- Sub-millisecond reads from a hash keyed per `tenantId`
- 60-second TTL (acceptable staleness for feature flags)
- Populated on API startup + refreshed on every `tenant_flag_overrides` write
- Invalidated immediately on override change (via BullMQ job or direct `DEL`)

**SaaS deployment**: Scaleway Managed Redis EU (single GDPR DPA, no cluster to operate).
**Self-hosted NPO deployment**: Redis 8 / Valkey via Docker Compose.

### 3.3 Evaluation: `@givernance/shared/flags`

A pure TypeScript module in the `shared` package resolves flags with no external I/O:

```
Input:  flagKey + { tenantId, plan, overrides: Record<string, boolean> }
Output: boolean
```

This keeps flag evaluation testable without Redis/PostgreSQL in unit tests.

### 3.4 Frontend: React context + SSR

Next.js 16 server components fetch the flag map once per request from the API. The map is passed via `<FlagProvider>` context to client components. This ensures:

- No client-side API calls for flags (no waterfall, no flash of wrong content)
- SSR-safe: server components can call `notFound()` before sending HTML
- Type-safe: flag keys are typed from the shared registry

## 4. Data Model

### 4.1 `feature_flags` table

Source of truth for all flag definitions.

```sql
CREATE TABLE feature_flags (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  key           TEXT NOT NULL UNIQUE,        -- 'ff.payments.sepa_direct_debit'
  default_value BOOLEAN NOT NULL DEFAULT false,
  scope         TEXT NOT NULL,               -- 'global' | 'tenant' | 'user'
  plan_gate     TEXT,                        -- matches tenants.plan_id values (e.g. 'starter', 'pro', 'enterprise') — align with doc-08 when tiers are finalised
  description   TEXT NOT NULL,
  deprecated    BOOLEAN NOT NULL DEFAULT false,
  deprecated_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()  -- must be kept current via Drizzle $onUpdateFn(() => new Date()) or a DB trigger
);
```

### 4.2 `tenant_flag_overrides` table

Per-organisation overrides. Highest precedence in evaluation.

```sql
CREATE TABLE tenant_flag_overrides (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v7(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flag_key   TEXT NOT NULL REFERENCES feature_flags(key),
  value      BOOLEAN NOT NULL,
  set_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reason     TEXT,                           -- free-text, why this override exists
  expires_at TIMESTAMPTZ,                    -- NULL = permanent
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, flag_key)
);
```

### 4.3 Audit integration

Every `tenant_flag_overrides` INSERT/UPDATE/DELETE MUST emit an `audit_log` entry (note: doc-03 uses `audit_log` singular — align table name during Phase 1 schema reconciliation):

| Action | `action` field | `resource_type` |
|--------|----------------|-----------------|
| Override created | `feature_flag.override_set` | `feature_flag` |
| Override updated | `feature_flag.override_updated` | `feature_flag` |
| Override deleted | `feature_flag.override_removed` | `feature_flag` |
| Flag deprecated | `feature_flag.deprecated` | `feature_flag` |

## 5. Evaluation Algorithm

Flag resolution precedence (highest wins):

```
1. tenant_flag_overrides         → explicit per-org value
2. plan entitlement              → flag.plan_gate vs tenant.plan
3. feature_flags.default_value   → platform default
```

If the flag does not exist in the registry → `false` (unknown flags are off by default).
If the flag is `deprecated` → `false` (deprecated flags are always off).

## 6. Backend Enforcement

### 6.1 Fastify middleware guard (route-level)

```typescript
// packages/api/src/lib/flags/flag-guard.ts
export function requireFlag(flagKey: string): preHandlerHookHandler {
  return async (req, reply) => {
    const enabled = await req.flagService.isEnabled(flagKey, req.tenant.id);
    if (!enabled) {
      // 404 not 403: silent denial, does not confirm feature existence
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Route not found',
      });
    }
  };
}
```

**Usage in `routes.ts`:**

```typescript
fastify.post('/payments/sepa/mandates', {
  preHandler: [authenticate, requireFlag('ff.payments.sepa_direct_debit')],
  schema: CreateSepaMandateSchema,
}, createSepaMandateHandler);
```

### 6.2 Service-layer guard (sub-operation)

For flags that gate a step within a larger operation (not the whole route):

```typescript
if (!await flagService.isEnabled('ff.ai.segment_builder', tenantId)) {
  throw new FeatureNotAvailableError('ff.ai.segment_builder');
}
```

### 6.3 BullMQ processor guard

Worker jobs must also check the flag at the start of processing, because the flag may have been disabled between job enqueue and processing:

```typescript
// packages/worker/src/processors/sepa-mandate.processor.ts
async function processSepaMandateJob(job: Job) {
  const enabled = await flagService.isEnabled('ff.payments.sepa_direct_debit', job.data.tenantId);
  if (!enabled) {
    await job.moveToCompleted('flag-disabled', true); // Drop silently — flag was disabled after enqueue
    // Note: job.discard() was removed in BullMQ 5; use moveToCompleted or simply return
    return;
  }
  // ... rest of processor
}
```

## 7. Frontend Enforcement

### 7.1 Server-side: page/layout gate

Pages dedicated to a gated feature are enforced at the server component level:

```typescript
// app/(tenant)/settings/payments/sepa/page.tsx
export default async function SepaSettingsPage() {
  const flags = await getFlagsForTenant(tenantId);
  if (!flags['ff.payments.sepa_direct_debit']) notFound();
  return <SepaSettingsContent />;
}
```

### 7.2 Client-side: UI element toggle

UI elements within mixed pages use the `useFlags()` hook:

```tsx
const { isEnabled } = useFlags();

return (
  <PaymentMethodList>
    {isEnabled('ff.payments.sepa_direct_debit') && <SepaPaymentOption />}
    <StripeCardOption />   {/* always visible */}
  </PaymentMethodList>
);
```

### 7.3 Navigation menu

Menu items for gated features must be hidden when the flag is off. Enforce in the server component that builds the sidebar nav config, not client-side:

```typescript
// Server component — builds nav items
const navItems = buildNavItems({ flags });
// SepaSettings item omitted from navItems when flag is off
```

## 8. Flag Lifecycle

```
PROPOSED → ACTIVE (off) → TEST_TENANT → GA_ROLLOUT → GA (on by default) → DEPRECATED → REMOVED
```

| Stage | DB state | Code state | Who can change |
|---|---|---|---|
| `PROPOSED` | Not in DB yet | Not in code yet | — |
| `ACTIVE` | `default_value = false` | Gate in place | `super_admin` activates for test tenants via override |
| `TEST_TENANT` | Override row for test tenant(s), `default = false` | Gate in place | `super_admin` |
| `GA_ROLLOUT` | Overrides for consenting orgs, `default = false` | Gate in place | `super_admin` |
| `GA` | `default_value = true` | Gate in place | `super_admin` |
| `DEPRECATED` | `deprecated = true`, `deprecated_at` set | Gate still in place (returns false) | `super_admin` |
| `REMOVED` | Row deleted | Code gates and flag key removed | Developer (PR) |

**GA criteria** (minimum before setting `default_value = true`):
- ✅ Tested on at least 1 production test tenant for ≥ 2 weeks without critical bug
- ✅ QA test suite includes both "flag on" and "flag off" paths
- ✅ No open HIGH issues in the feature's spike doc
- ✅ Security Architect sign-off if the feature handles PII or payments

**`REMOVED` — worked example (issue #493).** Once a flag has been GA + on everywhere long enough to be permanent, the gate is dead code. Retirement is a single PR that: (1) deletes every `requireFlag` / worker `isFlagEnabled` / SSR `xEnabled` consumer, keeping only the enabled code path; (2) removes the `FEATURE_FLAG_KEYS` + `FEATURE_FLAG_REGISTRY` entries (the shrinking `FeatureFlagKey` union makes the compiler list every orphaned reference); (3) ships a new migration that `DELETE`s the `tenant_flag_overrides` rows **before** the `feature_flags` rows (FK order) — original seed migrations stay immutable; (4) updates the parity + off-state tests so they pass with the rows gone. Issue #493 retired `admin.feature_flags_phase2`, `admin.finance_dashboard`, `admin.impersonation_replicate`, `communication.notifications_center`, and `productivity.command_palette` this way (migration `0082`). Note the special case: `admin.feature_flags_phase2` gated the per-org flag *tooling itself*, so its retirement removed **only its own gate** — the tooling stays, because the surviving flags still need it.

## 9. Flag Administration API

### Super-admin endpoints

```
GET    /admin/feature-flags               → list all flags with defaults
GET    /admin/feature-flags/:key          → single flag detail
PATCH  /admin/feature-flags/:key          → update default_value, plan_gate, deprecated

GET    /admin/tenants/:id/feature-flags   → list all overrides for a tenant
PUT    /admin/tenants/:id/feature-flags/:key   → upsert override (PUT semantics: full replacement; use PATCH if partial update needed)
DELETE /admin/tenants/:id/feature-flags/:key   → remove override (revert to default)
```

All endpoints: `RBAC.SUPER_ADMIN` required + audit logged.

### Tenant self-service (within plan allowance)

```
GET    /org/feature-flags                 → list flags this org can toggle
PATCH  /org/feature-flags/:key            → toggle flag (only scope=tenant flags within plan)
```

`RBAC.ORG_ADMIN` required + audit logged.

## 10. GDPR Considerations

| Concern | Mitigation |
|---|---|
| `set_by` (user UUID in `tenant_flag_overrides`) | Included in tenant data export (GDPR Art. 15); cleared (`SET NULL`) on user erasure |
| `reason` field | Free-text field — document rule: **do not write constituent names, emails, or other PII into `reason`** |
| `expires_at` | Always set for temporary test access; prevents forgotten "test" overrides becoming permanent |
| Flag evaluation logs | Log `flagKey` + `tenantId` + boolean result only — never userId, email, or other PII |
| Audit trail | Every override change → `audit_log` entry (see §4.3) |
| Tenant deletion | `tenant_flag_overrides` rows cascade-delete on tenant deletion |
| Data portability | `tenant_flag_overrides` included in GDPR Art. 15 data export for that tenant |

## 11. Cross-Agent Rules

### For MVP Engineer

- Every new Fastify route for a non-MVP feature **MUST** include `requireFlag()` in `preHandler`
- Every BullMQ processor implementing a gated feature **MUST** check the flag at job start (see §6.3)
- Flag keys **MUST** be imported from `@givernance/shared/flags/registry` — no inline strings in route files
- Drizzle schema changes for gated features **SHOULD** still run in migrations (flag gates logic, not schema)
- The `packages/shared/src/flags/registry.ts` file is the single source of truth; update it in the same PR as the flag gate

### For QA Engineer

- Integration tests **MUST** cover the "flag off" path: route returns 404 when `requireFlag()` blocks
- Integration tests **MUST** cover the "flag on" path: feature works correctly for a flag-enabled tenant
- RLS isolation: flag override for tenant A **MUST NOT** affect tenant B (test this explicitly)
- Add test fixture helpers: `enableFlag(tenantId, flagKey)` / `disableFlag(tenantId, flagKey)` in `packages/api/test/helpers/`
- Frontend: add Playwright test that verifies the flagged page returns 404 when flag is off

### For Security Architect

- Override endpoints (super_admin) **MUST** be behind `RBAC.SUPER_ADMIN` + audit logged
- Tenant override endpoints **MUST** verify the flag's `scope` allows tenant-level control (reject requests to override `global` flags)
- Plan gate **MUST NOT** be bypassable by a tenant override for flags with `planGate: 'strict'` (future enhancement; track as open question)
- Redis cache keys **MUST NOT** include user identifiers — only `tenantId`

### For Data Architect

- `feature_flags` and `tenant_flag_overrides` are platform tables — no tenant-scoped RLS needed (no `tenant_id` partitioning on `feature_flags` itself)
- `tenant_flag_overrides` rows **MUST** be included in tenant data export (GDPR Art. 15)
- On tenant deletion: cascade-delete `tenant_flag_overrides` rows automatically (FK + `ON DELETE CASCADE`)
- Add both tables to the Drizzle schema in `packages/shared/src/schema/`

### For Log Analyst

- Flag evaluation **MUST NOT** log PII — only `flagKey`, `tenantId`, and the boolean result
- Override changes **MUST** be logged at `info` level with `audit: true` in the structured log + written to `audit_log`
- Redis cache miss events are `debug` level only (high volume, not business-relevant)
- Add `ff.override_set`, `ff.override_removed` to the audit events catalog in `docs/17-log-management.md`

## 12. Open Questions

- [ ] **Strict plan gate** — should super_admin be able to override a `planGate` for a tenant on a free tier? (e.g. demo access). Proposal: add a `strict` boolean on `feature_flags`. If `strict = true`, plan gate cannot be overridden even by super_admin.
- [ ] **User-scoped flags** — scope `user` is defined but not implemented in Phase 1. Is there a Phase 1 use case (beta opt-in UI)? If not, defer to Phase 2.
- [ ] **Flag analytics** — should we track flag evaluation counts per tenant to understand adoption before GA? Proposal: increment a Redis counter per flag per tenant per day, flush to PG nightly.
- [ ] **Frontend type safety** — flag keys are strings today. Should we generate a TypeScript enum from the registry at build time to catch typos at compile time?
- [ ] **Webhook/outbound event gate** — if a webhook integration is behind a flag (e.g. Xero), should the flag also suppress domain events that would trigger that webhook, or let the webhook processor handle it?
- [ ] **Migration tool** — does `givernance-migrate` need to respect feature flags? (e.g. skip migrating SEPA mandates if the flag is off for the target tenant)

## 13. Implementation Phases

### Phase 1 (Skeleton sprint — no feature-specific flags yet)

- [ ] `feature_flags` + `tenant_flag_overrides` Drizzle schema in `packages/shared`
- [ ] `packages/shared/src/flags/registry.ts` — typed registry module
- [ ] `packages/shared/src/flags/evaluate.ts` — pure evaluation function (no I/O)
- [ ] `FlagService` in `packages/api/src/lib/flags/` — Redis cache + PG fallback
- [ ] `requireFlag()` Fastify preHandler in `packages/api/src/lib/flags/`
- [ ] Super-admin CRUD API for `feature_flags` and `tenant_flag_overrides`
- [ ] Redis warm-up on API startup (load all flags from PG into Redis)
- [ ] Redis invalidation on override change (BullMQ job or direct `DEL`)
- [ ] Audit log integration for all override mutations
- [ ] `FlagProvider` + `useFlags()` in `packages/web/src/lib/flags/`
- [ ] Test fixture helpers in `packages/api/test/helpers/flags.ts`
- [ ] Integration tests: flag off → 404, flag on → 200, tenant isolation

### Phase 1+ (First gated feature — SEPA Direct Debit)

- [ ] Register `ff.payments.sepa_direct_debit` in the registry
- [ ] Add `requireFlag('ff.payments.sepa_direct_debit')` to all SEPA routes
- [ ] Add SSR gate to `/settings/payments/sepa` Next.js page
- [ ] Add `isEnabled` check to SEPA BullMQ processor
- [ ] Enable on test tenant; validate end-to-end
