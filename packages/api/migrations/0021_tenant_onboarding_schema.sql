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

-- ─── tenants: lifecycle + provenance ──────────────────────────────────────────

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS created_via      VARCHAR(32)  NOT NULL DEFAULT 'enterprise',
    ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS keycloak_org_id  TEXT,
    ADD COLUMN IF NOT EXISTS primary_domain   VARCHAR(255);

-- Existing `status` column uses VARCHAR(50) DEFAULT 'active' with no CHECK constraint.
-- Keep the width unchanged and add the CHECK + back-fill the new vocabulary.
UPDATE tenants SET status = 'active' WHERE status IS NULL;

ALTER TABLE tenants
    ADD CONSTRAINT tenants_status_chk
        CHECK (status IN ('provisional','active','suspended','archived')),
    ADD CONSTRAINT tenants_created_via_chk
        CHECK (created_via IN ('self_serve','enterprise','invitation')),
    -- primary_domain, if set, must be a lowercase host (coarse check — validators
    -- enforce the fine-grained syntax at the API layer).
    ADD CONSTRAINT tenants_primary_domain_lower_chk
        CHECK (primary_domain IS NULL OR primary_domain = lower(primary_domain));

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
    -- Domain is always stored lowercase; keep the column narrow enough to be
    -- a btree key without TOAST.
    CONSTRAINT tenant_domains_lowercase_chk
        CHECK (domain = lower(domain))
);

-- A domain claim is globally unique — once `ngo.fr` is bound to Org A,
-- no other tenant can claim it. Revoked claims release the slot. Partial
-- unique index avoids a dependency on btree_gist that EXCLUDE would need.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_active_domain_uniq
    ON tenant_domains (domain) WHERE state <> 'revoked';

CREATE INDEX IF NOT EXISTS tenant_domains_org_id_idx ON tenant_domains (org_id);
CREATE INDEX IF NOT EXISTS tenant_domains_state_idx  ON tenant_domains (state);

ALTER TABLE tenant_domains ENABLE  ROW LEVEL SECURITY;
ALTER TABLE tenant_domains FORCE   ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_domains
    USING (org_id = app_current_organization_id());

-- ─── tenant_admin_disputes ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tenant_admin_disputes (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    disputer_id             UUID NOT NULL REFERENCES users(id),
    provisional_admin_id    UUID NOT NULL REFERENCES users(id),
    reason                  TEXT,
    resolution              VARCHAR(32),
    resolved_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT tenant_admin_disputes_resolution_chk
        CHECK (resolution IS NULL
               OR resolution IN ('kept','replaced','escalated_to_support')),
    CONSTRAINT tenant_admin_disputes_different_actors_chk
        CHECK (disputer_id <> provisional_admin_id)
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
    USING (org_id = app_current_organization_id());
