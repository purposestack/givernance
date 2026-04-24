# 18 — Feature Flag Strategy

> **Status**: Spike / Analysis — Phase 1 implementation target
> **Owner**: Feature Flag Engineer agent (`.claude/agents/feature-flag-engineer.md`)
> **Related**: `02-reference-architecture.md`, `03-data-model.md`, `04-business-capabilities.md`, `06-security-compliance.md`, `07-delivery-roadmap.md`

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
**Self-hosted NPO deployment**: Redis 7 / Valkey via Docker Compose.

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
