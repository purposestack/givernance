-- 0021_tenant_onboarding_schema.sql
-- Foundation for the Tenant Onboarding & Multi-Tenancy milestone (ADR-016).
--
-- 1. Extends `tenants` with lifecycle + provenance columns so the self-serve
--    and enterprise tracks can share one table.
-- 2. Adds `first_admin` + `provisional_until` on `users` for the 7-day
--    provisional-admin grace period (doc 22 §3.1, §4.4).
-- 3. Creates `tenant_domains` (domain claim + DNS TXT verification state)
--    and `tenant_admin_disputes` (grace-period dispute log).
--
-- Existing tenants are back-filled with status='active' / created_via='enterprise'
-- so the Phase 1 super-admin-provisioned rows keep working unchanged.
--
-- Naming: every new constraint / index is explicitly named so integration
-- tests can assert against stable error strings (see
-- `tenant-onboarding-schema.test.ts`). A future migration that renames a
-- constraint MUST update the matching test regex.

-- ─── tenants: lifecycle + provenance ──────────────────────────────────────────

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS created_via      VARCHAR(32)  NOT NULL DEFAULT 'enterprise',
    ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS keycloak_org_id  VARCHAR(64),
    ADD COLUMN IF NOT EXISTS primary_domain   VARCHAR(255);

-- Existing `status` column is NOT NULL DEFAULT 'active' (migration 0002) so
-- the legacy rows are already at 'active'; column defaults cover the new
-- columns. We add the CHECK constraints directly without a back-fill UPDATE.
ALTER TABLE tenants
    ADD CONSTRAINT tenants_status_chk
        CHECK (status IN ('provisional','active','suspended','archived')),
    ADD CONSTRAINT tenants_created_via_chk
        CHECK (created_via IN ('self_serve','enterprise','invitation')),
    ADD CONSTRAINT tenants_primary_domain_lower_chk
        CHECK (primary_domain IS NULL OR primary_domain = lower(primary_domain)),
    -- Keycloak 26 Organization ids are UUIDs. Reject anything else to
    -- prevent typos from silently binding a tenant to the wrong KC org.
    ADD CONSTRAINT tenants_keycloak_org_id_uuid_chk
        CHECK (keycloak_org_id IS NULL
               OR keycloak_org_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    -- Self-serve tenants must either be provisional or have been verified.
    -- Enterprise/invitation rows can be in any state (super-admin drives them).
    ADD CONSTRAINT tenants_self_serve_requires_verification_chk
        CHECK (created_via <> 'self_serve'
               OR status = 'provisional'
               OR verified_at IS NOT NULL);

-- One Keycloak Organization id per tenant at most.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_keycloak_org_id_uniq
    ON tenants (keycloak_org_id)
    WHERE keycloak_org_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS tenants_status_idx       ON tenants (status);
CREATE INDEX IF NOT EXISTS tenants_created_via_idx  ON tenants (created_via);

-- ─── users: provisional-admin flags ──────────────────────────────────────────

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS first_admin       BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS provisional_until TIMESTAMPTZ,
    ADD CONSTRAINT users_provisional_requires_first_admin_chk
        CHECK (provisional_until IS NULL OR first_admin = true);

-- At most one first_admin per tenant. If the provisional admin is replaced
-- via a dispute, the replacement swap MUST flip the old first_admin=false
-- in the same transaction. Prevents privilege-escalation via dup flags.
CREATE UNIQUE INDEX IF NOT EXISTS users_one_first_admin_per_org
    ON users (org_id) WHERE first_admin = true;

-- ─── tenant_domains ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_domains (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain          VARCHAR(255) NOT NULL,
    state           VARCHAR(32)  NOT NULL DEFAULT 'pending_dns',
    dns_txt_value   VARCHAR(128) NOT NULL,
    verified_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT tenant_domains_state_chk
        CHECK (state IN ('pending_dns','verified','revoked')),
    -- Domain is always stored lowercase.
    CONSTRAINT tenant_domains_lowercase_chk
        CHECK (domain = lower(domain)),
    -- DNS TXT tokens must carry real entropy (≥32 chars). The generator ships
    -- base64url of 24+ random bytes (=> 32 chars); the floor here rejects any
    -- bypass that would let a weak token verify a domain.
    CONSTRAINT tenant_domains_dns_txt_entropy_chk
        CHECK (length(dns_txt_value) >= 32)
);

-- A domain claim is globally unique — once `ngo.fr` is bound to Org A,
-- no other tenant can claim it. Revoked claims release the slot. Partial
-- unique index avoids a dependency on btree_gist that EXCLUDE would need.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_active_domain_uniq
    ON tenant_domains (domain) WHERE state <> 'revoked';

-- DNS TXT values must be unique across active rows too, so two domains
-- cannot accidentally share the same proof token.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_active_txt_uniq
    ON tenant_domains (dns_txt_value) WHERE state <> 'revoked';

CREATE INDEX IF NOT EXISTS tenant_domains_org_id_idx ON tenant_domains (org_id);
CREATE INDEX IF NOT EXISTS tenant_domains_state_idx  ON tenant_domains (state);
-- Hot-path index for "give me this tenant's verified domains" (Home IdP Discovery,
-- login-side domain lookup). Partial covers the common case cheaply.
CREATE INDEX IF NOT EXISTS tenant_domains_verified_by_org_idx
    ON tenant_domains (org_id) WHERE state = 'verified';

ALTER TABLE tenant_domains ENABLE  ROW LEVEL SECURITY;
ALTER TABLE tenant_domains FORCE   ROW LEVEL SECURITY;

-- FOR ALL + WITH CHECK ensures RLS applies to SELECT/INSERT/UPDATE/DELETE,
-- and that a bug in the API layer cannot write a row with the wrong org_id.
CREATE POLICY tenant_isolation ON tenant_domains
    FOR ALL
    USING      (org_id = app_current_organization_id())
    WITH CHECK (org_id = app_current_organization_id());

-- Auto-maintain updated_at on every write.
CREATE OR REPLACE FUNCTION tenant_domains_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_domains_updated_at_trg
    BEFORE UPDATE ON tenant_domains
    FOR EACH ROW EXECUTE FUNCTION tenant_domains_set_updated_at();

-- ─── tenant_admin_disputes ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_admin_disputes (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    -- ON DELETE SET NULL so GDPR Art. 17 user erasures don't fail on FK.
    -- The dispute row is retained with the NULL placeholder for audit.
    disputer_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    provisional_admin_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    reason                  VARCHAR(2000),
    resolution              VARCHAR(32),
    resolved_at             TIMESTAMPTZ,
    resolved_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT tenant_admin_disputes_resolution_chk
        CHECK (resolution IS NULL
               OR resolution IN ('kept','replaced','escalated_to_support')),
    -- disputer and provisional admin must be different *when both are
    -- non-null*. GDPR erasure may null them independently.
    CONSTRAINT tenant_admin_disputes_different_actors_chk
        CHECK (disputer_id IS NULL
               OR provisional_admin_id IS NULL
               OR disputer_id <> provisional_admin_id),
    -- resolution and resolved_at must co-exist.
    CONSTRAINT tenant_admin_disputes_resolved_consistency_chk
        CHECK ((resolution IS NULL AND resolved_at IS NULL)
               OR (resolution IS NOT NULL AND resolved_at IS NOT NULL))
);

-- One open dispute per tenant at most. Closed disputes (resolution set)
-- don't block a new one. Partial unique index avoids btree_gist.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_admin_disputes_one_open_per_tenant
    ON tenant_admin_disputes (org_id) WHERE resolution IS NULL;

CREATE INDEX IF NOT EXISTS tenant_admin_disputes_org_id_idx
    ON tenant_admin_disputes (org_id);

ALTER TABLE tenant_admin_disputes ENABLE  ROW LEVEL SECURITY;
ALTER TABLE tenant_admin_disputes FORCE   ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_admin_disputes
    FOR ALL
    USING      (org_id = app_current_organization_id())
    WITH CHECK (org_id = app_current_organization_id());

CREATE OR REPLACE FUNCTION tenant_admin_disputes_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_admin_disputes_updated_at_trg
    BEFORE UPDATE ON tenant_admin_disputes
    FOR EACH ROW EXECUTE FUNCTION tenant_admin_disputes_set_updated_at();

-- ─── Explicit grants to givernance_app ───────────────────────────────────────
-- Matches the pattern from migrations 0008, 0009, 0010, 0017, 0018.
-- ALTER DEFAULT PRIVILEGES from 0005 handles the common case, but explicit
-- grants are robust to environments where migrations were historically
-- run as a different role.
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_domains         TO givernance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_admin_disputes  TO givernance_app;
