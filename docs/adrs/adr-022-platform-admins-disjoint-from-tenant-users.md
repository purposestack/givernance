## ADR-022: Platform Admins Disjoint from Tenant Users — `platform_admins` Table over `PLATFORM_TENANT_ID` Sentinel

**Status**: Accepted (issue #252)
**Related**: ADR-016 (tenant onboarding & KC organizations), ADR-017 (one logical DB per tool), ADR-021 (user lifecycle — soft-delete), `docs/19-impersonation.md` (impersonation strategy)

### Context

Phase 1 modeled Givernance super-admins (platform staff with the Keycloak realm role `super_admin`) as `users` rows pointing at a synthetic "platform" tenant — a `tenants` row whose UUID was pinned at `00000000-0000-0000-0000-0000000000a1` and exposed as the constant `PLATFORM_TENANT_ID` in `@givernance/shared/constants`. The impersonation guard refused to start a session against any target whose `org_id` matched this sentinel, on the rationale that nested operator-on-operator impersonation breaks the audit chain.

Two consequences surfaced:

1. **Dev-seed UUID collision.** The seeded "Givernance Demo NPO" tenant reused the platform UUID so the seeded super-admin would land in a tenant with realistic data on first login. Any user created inside that demo NPO — a perfectly normal org-admin — tripped the impersonation guard with `Cannot impersonate a platform user; nested impersonation is forbidden`. Structurally, an org-admin in a customer tenant looked identical to a Givernance staffer.
2. **Audit story buried under a magic UUID.** "List every super-admin we have ever had" required `users JOIN tenants ON tenants.id = users.org_id WHERE tenants.id = '…a1'`. Super-admins are a regulated identity surface — the people who can read across tenants and start impersonation sessions. The source of truth deserved a first-class table that an SOC reviewer or DPO can query without folklore.

ADR-021 already noted in passing that "super-admins are platform principals; they don't have a `users` row in any tenant by design" — but the seed and the impersonation guard were both treating super-admins *as if* they did. ADR-022 reconciles the codebase with ADR-021's stated position.

### Decision

Platform admins are modeled as a separate identity surface from tenant users. A new table `platform_admins` holds the staff records; the `users` table holds tenant members only. **A single Keycloak person belongs to exactly one of the two** — never both. If staff need to see what a customer sees, they impersonate (that is the feature).

| Property | `users` (tenant members) | `platform_admins` (staff) |
|---|---|---|
| Tenant binding | `org_id NOT NULL` → `tenants.id` | None — no `org_id`, no FK to `tenants` |
| Source of truth for "is super-admin?" | (n/a) | Row in `platform_admins WHERE deleted_at IS NULL` |
| Source of truth for runtime authorization | (n/a) | Keycloak realm role `super_admin` (unchanged) |
| Lifecycle | Soft-delete (ADR-021) | Soft-delete (ADR-021 universal rule) |
| RLS | Yes — `org_id` drives the policy | No — accessed only through `systemDb` (BYPASSRLS) |
| Visible to the picker / list endpoints | Yes (filtered by tenant) | No — staff are not impersonation targets |

#### Schema

`platform_admins`:
- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `keycloak_id varchar(255) NOT NULL` — the JWT `sub`; nullable only across rejoin (mirrors `users.keycloak_id` semantics)
- `email varchar(255) NOT NULL`
- `first_name varchar(255) NOT NULL`
- `last_name varchar(255) NOT NULL`
- `last_login_at timestamptz` — useful for the audit story ("who has been active in the last 30 days")
- `deleted_at timestamptz` — soft-delete (ADR-021)
- `created_at timestamptz NOT NULL DEFAULT now()`
- `updated_at timestamptz NOT NULL DEFAULT now()`

Indexes:
- `UNIQUE INDEX platform_admins_keycloak_id_uniq ON (keycloak_id) WHERE deleted_at IS NULL` — same partial-unique pattern as `users`, so an offboarded super-admin's email/keycloak-id can be re-issued cleanly.
- `UNIQUE INDEX platform_admins_email_uniq ON (lower(email)) WHERE deleted_at IS NULL` — case-insensitive, same partial pattern.

The table sits outside RLS. It is read and written exclusively through `systemDb` (the BYPASSRLS owner role).

#### Impersonation guard

The guard becomes a single indexed lookup against `platform_admins.keycloak_id`. It no longer references any UUID constant:

```ts
const isPlatformAdmin = await systemDb.execute(sql`
  SELECT 1 FROM platform_admins
  WHERE keycloak_id = ${target.keycloakId}
    AND deleted_at IS NULL
  LIMIT 1
`);
if (isPlatformAdmin.rows.length > 0) {
  throw new ImpersonationServiceError(
    400,
    "TARGET_NESTED_SUPER_ADMIN",
    "Cannot impersonate a platform admin; nested impersonation is forbidden.",
  );
}
```

The error code `TARGET_NESTED_SUPER_ADMIN` is preserved (clients/test suites depend on it). The structural meaning is unchanged: nested operator-on-operator impersonation is rejected.

#### `/v1/users/me` branches on identity surface

The endpoint now branches on the JWT's realm roles:

- **`super_admin` realm role present** → resolve via `platform_admins` keyed on `keycloak_id`. The response payload uses a `kind: "platform_admin"` discriminator and omits `orgId` / `orgSlug` / `orgName`. The frontend's sidebar and switcher render the platform-admin variant of the chrome.
- **otherwise** → existing path: inner-join `users` ↔ `tenants` on `(sub, org_id)`, return the tenant-scoped profile.

The two payload shapes are exposed as a discriminated union on the OpenAPI schema so clients can switch on `kind`.

#### Keycloak realm seed

The Keycloak side is largely unchanged:

- The "Givernance Platform" Organization stays as a logical grouping for staff.
- Its `org_id` attribute (`…a1`) is retained because the OIDC Organization Membership Mapper requires the attribute to emit the `org_id` claim. Super-admin tokens still carry `org_id: …a1`.
- The seeded super-admin user's user-attribute `org_id` stays for now (the `keycloak-realm-seed.test.ts` cross-check remains green); a follow-up may remove it once the JWT verifier reads the org membership exclusively from the Organization mapper.

The application no longer creates a `tenants` row at `…a1`. The `org_id` claim on a super-admin token is a Keycloak-side detail that no app-DB row mirrors. The auth plugin already exempts super-admins from the active-row check (per ADR-021), so the absence of a matching tenant row is correct, not broken.

#### Dev seed

- The synthetic platform tenant insert is removed.
- "Givernance Demo NPO" moves to a fresh UUID `00000000-0000-0000-0000-0000000000c1`. The seeded constituents/campaigns/donations land here. This is the data-rich tenant.
- "Demo Workspace (impersonation playground)" stays at `…b1` with its three pre-seeded users (Camille / Léo / Inès). Empty playground for clean-flow testing.
- The seeded super-admin lands in `platform_admins` (not `users`).

The Keycloak realm-import keeps the seeded admin user's `org_id` attribute at `…a1` (matching the platform Organization). The app DB has no row at `…a1`; the auth plugin's super-admin exemption makes this fine.

### Amendment (issue #254): sentinel platform tenant row for audit FK integrity

The original ADR-022 statement "drop the synthetic platform `tenants` row" was tightened during PR #253 + #254 implementation. `audit_logs.org_id` is `NOT NULL REFERENCES tenants(id)`, so platform-level lifecycle events (the new platform-admin CRUD writes `platform_admin.created`, `platform_admin.renamed`, `platform_admin.password_reset_sent`, `platform_admin.removed` audit rows) need a tenant id to FK against.

We keep ONE row in `tenants` at the platform id (`…a1`), distinguished from customer tenants by:

- `slug = '__platform__'` — double-underscore is reserved (ADR-016 reserved-slugs guard) so it cannot collide with a user-facing slug.
- `status = 'archived'` — every customer-facing list endpoint filters `status != 'archived'` already, so the row is structurally invisible.
- `name = 'Givernance Platform (sentinel)'` — human-readable so an SOC reviewer grepping `audit_logs` recognises the row.

This row is **not** a tenant in any operational sense:
- No `users` row points at it (super-admins live in `platform_admins`; the invariant "every `users.org_id` resolves to a customer tenant" still holds because customer-facing code filters by status).
- No constituents / campaigns / donations / impersonation sessions reference it.
- The dev seed creates it idempotently; production deployments must apply the same insert as part of the deploy bootstrap.

The amendment is the minimum-viable compromise: ADR-022's core wins (disjoint identity surface, no `PLATFORM_TENANT_ID` constant in app code, no UUID-equality magic in the impersonation guard) are preserved.

### Consequences

**Wins:**
- The "Givernance Demo NPO" tenant becomes a real customer tenant for testing — org-admins inside it can be impersonated end-to-end without tripping the nested-impersonation guard.
- The audit story is trivial: `SELECT * FROM platform_admins`. Including soft-deleted rows: `SELECT * FROM platform_admins WHERE deleted_at IS NOT NULL`.
- The `PLATFORM_TENANT_ID` magic constant disappears from the application codebase. No code path depends on a UUID literal.
- `users.org_id` stays `NOT NULL` and always points at a real customer tenant. The schema invariant "every `users` row belongs to a real customer" is now true at the type level.
- An accidental future schema change can no longer introduce a tenant whose UUID happens to collide with the platform sentinel. There is no platform sentinel anymore.

**Costs:**
- Two identity surfaces means two lookup paths in `/v1/users/me` and any future endpoint that has to render "the current user's profile". The discriminated-union payload shape is the explicit cost.
- Listings that need to attribute "who took this action" across both staff and tenant users (e.g. cross-tenant audit timeline) need to UNION over both tables when the join is by `keycloak_id`. The `audit_logs` table already references `keycloak_id` strings (not `users.id` UUIDs), so existing audit queries are not affected.
- A schema migration is required. There are no existing rows to migrate (Phase 0/1; production not yet deployed), so the migration is purely additive plus a removal of the platform `tenants` insert from the dev seed.

### Rejected alternatives

- **Boolean `users.is_super_admin` column.** Rejected because it does not free `users.org_id` from the requirement to point at a synthetic tenant. The collision risk would persist.
- **Look up Keycloak realm roles for the target via the Admin API.** Rejected because it adds a per-`startSession` round-trip and creates a hard dependency on Keycloak availability for the impersonation guard. The DB lookup is local, fast, and survives a Keycloak outage.
- **Drop the impersonation guard entirely.** Rejected. Operator-on-operator impersonation breaks audit accountability and has no legitimate support use case.
- **Keep `PLATFORM_TENANT_ID` and rename the colliding seed tenant.** Rejected because it leaves the sentinel UUID as a load-bearing constant in production code, which is the root cause of the audit-discoverability problem, not just the dev-seed collision.

### Revisit criteria

Revisit if any of the following becomes true:
- A platform admin needs to be a tenant member at the same time (e.g. Givernance staff become customers of their own product). Today the answer is "use a separate Keycloak account"; if that becomes onerous, ADR-022 must be reopened and the disjoint-identity invariant relaxed.
- Cross-tenant audit timelines need to render the actor's display name without a UNION across `users` and `platform_admins` becoming a hot-path bottleneck. A materialized `principals` view spanning both tables would address this without collapsing them.
