## ADR-013: Frontend Type Boundary — No Drizzle Imports in Web Package

- **Status**: Accepted
- **Date**: 2026-04-16
- **Deciders**: Magino (founder/architect)

### Context

Givernance is a full-stack TypeScript monorepo (ADR-002) where `@givernance/shared` exports five subpath modules:

| Subpath | Contents | Runtime dependency |
|---|---|---|
| `@givernance/shared/schema` | Drizzle ORM table definitions (`pgTable`, columns, relations) | `drizzle-orm`, `drizzle-orm/pg-core` |
| `@givernance/shared/types` | Pure TypeScript interfaces and enums (`AuthContext`, `Currency`, `ConstituentType`) | None |
| `@givernance/shared/validators` | TypeBox schemas for request/response validation | `@sinclair/typebox` |
| `@givernance/shared/events` | Domain event type definitions (CloudEvents envelope, outbox types) | Type-only (no runtime import), but exposes internal system topology |
| `@givernance/shared/jobs` | Background job payload definitions | Type-only (no runtime import), but exposes worker capabilities and queue structure |

The frontend (`packages/web`, Next.js 16) communicates with the backend exclusively through REST API calls — it never connects to PostgreSQL directly. However, without explicit import restrictions, a developer could import Drizzle schema types into frontend code, creating type-safety illusions and security surface expansion.

Drizzle's `InferSelectModel<typeof constituents>` produces TypeScript types where:
- Date columns are typed as `Date` objects — but JSON serialization returns ISO 8601 strings
- Nullable columns include `null` — but API responses may use default values or omit fields
- `bigint` columns are typed as `bigint` — but `JSON.parse` returns `number`

These mismatches are invisible at compile time but cause runtime errors: `.toISOString()` called on a string, strict equality checks failing between `bigint` and `number`, and `null` propagating through UI components that expected `undefined`.

### Decision

Enforce a strict import boundary: **`packages/web` MUST NOT import from `@givernance/shared/schema`, `@givernance/shared/events`, or `@givernance/shared/jobs`.**

`packages/web` MAY import from:
- `@givernance/shared/types` — pure TypeScript interfaces with no runtime dependencies (enums, auth context, currency codes)
- `@givernance/shared/validators` — TypeBox schemas reused for client-side form validation (same validation rules on API and frontend, single source of truth per ADR-002)

Frontend-specific API response models live in `packages/web/src/models/` as plain TypeScript interfaces where dates are `string` (ISO 8601), matching JSON serialization reality (see ADR-011 Domain Models layer).

### Enforcement

| Mechanism | Layer | Description |
|---|---|---|
| Subpath exports | Package level | `@givernance/shared/package.json` declares explicit `"exports"` — only listed subpaths are resolvable |
| Lint rule | CI/IDE | Biome `noRestrictedImports` rule in `packages/web/biome.json` bans `@givernance/shared/schema`, `@givernance/shared/events`, `@givernance/shared/jobs` with actionable error messages |
| Code review | Process | PR reviews verify no new Drizzle imports in `packages/web/` |
| Source maps | Build config | Production builds (`next.config.ts`) MUST disable source maps (`productionBrowserSourceMaps: false`) to prevent exposing internal architecture via client-side JavaScript |

### Rationale

- **Type/runtime mismatch prevention**: Drizzle `InferSelectModel` types describe database row shapes, not JSON API response shapes. Using them in frontend code creates a false sense of type safety — the types compile but lie about runtime values. Frontend models must reflect what `JSON.parse` actually produces.
- **Server-only dependency containment**: Importing `@givernance/shared/schema` pulls `drizzle-orm` and `drizzle-orm/pg-core` into the Next.js bundle. These are server-only packages with Node.js dependencies (`pg`, `crypto`) that fail in browser environments and inflate bundle size.
- **Least privilege / attack surface reduction**: Domain events expose internal system topology (queue names, retry policies, outbox structure). Job definitions expose worker capabilities and processing semantics. Neither is needed by the frontend — exposing them violates the principle of least privilege and leaks architectural details that could inform targeted attacks.
- **GDPR defense in depth**: The API layer is the GDPR enforcement boundary — it applies RLS tenant isolation (`06-security-compliance.md`, 3-role pattern), RBAC permission checks, PII redaction, and audit logging before returning data. Frontend code that appears to "know" database column structure may encourage developers to bypass the API contract or assume field-level access that RBAC actually restricts. Maintaining a clean API boundary reinforces the single enforcement point for data protection.
- **Module boundary discipline**: Consistent with ADR-001 (modular monolith) — boundaries between modules are enforced via linting rules, not just convention. The frontend/backend boundary is the most critical module boundary in the system.

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Import Drizzle types directly (`InferSelectModel`) | Zero duplication, single type source | `Date` vs `string` mismatch causes runtime bugs; pulls `drizzle-orm` into browser bundle; false type safety | Rejected |
| Single barrel export from `@givernance/shared` | Simple imports (`from '@givernance/shared'`) | No boundary enforcement; any consumer gets everything; impossible to lint restricted imports | Rejected |
| Generate OpenAPI types from Fastify schemas | True contract-first; auto-generated frontend types | Requires `openapi-typescript` toolchain + CI codegen step; heavy for current team size (1-2 engineers); revisit at Phase 3 | Rejected — revisit at Phase 3 |
| Use Zod instead of TypeBox for shareable schemas | Zod is popular, good DX | Rejected per ADR-002 implementation note; TypeBox provides native Fastify integration and OpenAPI 3.1 compatibility without conversion | Rejected |
| **Subpath restriction + lint enforcement + frontend models** | Clean boundary, enforced at multiple layers, frontend types match JSON reality | Small duplication between DB types and API response types | **Selected** |

### Consequences

- ✅ **Runtime correctness**: Frontend types match actual JSON wire format — dates are `string`, numbers are `number`, no `bigint` surprises
- ✅ **Bundle safety**: `drizzle-orm` and `drizzle-orm/pg-core` never enter the Next.js client bundle — no Node.js polyfill failures, smaller bundle
- ✅ **GDPR enforcement boundary preserved**: The REST API remains the single point of GDPR control — RLS tenant isolation via `withTenantContext()`, RBAC permission matrix (`06-security-compliance.md`), PII redaction (Pino `redact` + RFC 9457 strict response schemas), and immutable audit logging. Frontend developers cannot accidentally circumvent data protection by importing database-level types that suggest direct field access
- ✅ **Security posture**: Internal system architecture (event topology, job queue structure, outbox design) is not exposed to frontend code — reduces information available to an attacker who gains access to client-side source maps or bundled JavaScript
- ✅ **Lint-enforced in CI**: Violations are caught by Biome before merge — not dependent on code review alone
- ✅ **Consistent with ADR-011**: The Domain Models layer in `packages/web/src/models/` is the designated home for frontend-specific API response types, reinforcing the layered service architecture
- ⚠️ **Type duplication**: API response interfaces in `packages/web/src/models/` partially duplicate fields from Drizzle schema types. This is intentional — the duplication reflects a real semantic difference (DB row shape vs. JSON response shape) and prevents a class of runtime bugs
- ⚠️ **Developer onboarding**: New developers must understand why `import { constituents } from '@givernance/shared/schema'` is banned in `packages/web/`. Lint error messages must include actionable guidance (e.g., "Import from `@/models/constituent` for API response types — see ADR-013")
- ⚠️ **OpenAPI codegen re-evaluation at Phase 3**: When the team grows beyond 2 engineers, auto-generating frontend types from Fastify route schemas (via `openapi-typescript`) should be re-evaluated to eliminate manual model maintenance while preserving the type boundary

---

### Campaign ROI Rule (2026-04-23)

Campaign ROI is a **read-model, never a stored field**.

- ROI is computed at read time in the API service layer from campaign primitives, not persisted on `campaigns`.
- The numerator uses **cleared donations only**, with **refunded donations subtracted** from raised totals.
- Pending and failed donations are excluded from ROI.
- Total campaign cost is `operational_cost_cents + platform_fees_cents`.
- Frontend code consumes the typed API read-model and must not recompute ROI from raw donation rows, consistent with ADR-011 and ADR-013.

---

### Node-only `shared/lib/*` subpaths (2026-08-03, issue #576)

The `@givernance/shared` package grew `./lib/*` subpath exports shared between API and worker. Several are **server-only** — they import `node:crypto` / `node:stream` builtins or Node-only third-party deps (`jsdom`, `@aws-sdk/client-s3`) — yet the original deny-list above only covered the root barrel, `schema`, `events`, and `jobs`. Nothing structurally prevented a future web import of e.g. `@givernance/shared/lib/receipt-crypto` from landing in a browser bundle.

The web-scoped `noRestrictedImports` override (which lives in the **root `biome.json`** `overrides` block scoped to `packages/web/src/**`, not in a per-package config) now also denies:

| Subpath | Why server-only |
|---|---|
| `@givernance/shared/lib/receipt-crypto` | `node:crypto` AES-256-GCM streams (ADR-037 envelope encryption) |
| `@givernance/shared/lib/s3-branding` | `@aws-sdk/client-s3` + `node:stream` |
| `@givernance/shared/lib/svg-sanitiser` | `jsdom` (DOMPurify host) |
| `@givernance/shared/lib/trace-context` | `node:crypto` W3C traceparent generation (forward-declared for PR #574) |

`@givernance/shared/lib/lru-fetch-cache` is deliberately **not** denied — it is pure isomorphic JS (only `lru-cache`) by design, per its module header.

**Parity enforcement**: `packages/shared/src/lib/web-import-guard.test.ts` scans every `./lib/*` export for Node-only import specifiers (`node:*`, `jsdom`, `@aws-sdk/*`) and fails CI if any such module lacks a deny entry in the web override — same lockstep pattern as the migrations-journal and feature-flag parity tests. A deny entry without a matching export (forward declaration) stays legal. When `shared` gains a new server-only dependency, extend the detector's specifier list in the same PR.
