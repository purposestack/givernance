-- Migration: 0087_customization_supporting_tables (Epic #539; docs/35)
--
-- Two supporting tables for the customization engine:
--
-- 1. `customization_quota_overrides` — the governed sales-exception
--    path for quota raises (Epic #539 §10). Plan quotas live in code
--    (`CUSTOM_FIELD_QUOTAS` in packages/shared/src/custom-fields/limits.ts);
--    a raise beyond the plan is a super-admin action with a MANDATORY
--    reason — a sales conversation with a paper trail, never a smuggled
--    toggle. Written via `systemDb` (owner role) from the super-admin
--    surface; the tenant-side quota check only READS it, hence the
--    SELECT-only grant for `givernance_app`.
--    `domain IS NULL` = org-wide raise; set = domain-scoped. The two
--    partial uniques below keep one live override per (org, quota[, domain])
--    — a new grant replaces the old row rather than stacking.
--
-- 2. `custom_field_merge_undo` — bounded TTL'd (30-day) reversal store
--    for option merges: one row per rewritten entity carrying ONLY the
--    pre-merge value of the touched key. Undo lives HERE, never as
--    per-row value snapshots in long-retention `audit_logs` (binding
--    anti-goal #7 — audit rows carry counts + ids only). The worker
--    cron purges rows past `expires_at`; `merge_id` groups one merge
--    operation (the undo unit). Written by the backfill worker under
--    `withWorkerContext`, hence the full grant.
--
-- TENANT-SCOPED. RLS enabled + FORCED on `org_id` for both. Per
-- CLAUDE.md "RLS is the safety net, never the contract" — every query
-- MUST also carry the explicit `eq(orgId, ctx.orgId)` predicate.

CREATE TABLE customization_quota_overrides (
  id         UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID                NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain     custom_field_domain,
  quota_key  VARCHAR(63)         NOT NULL,
  value      INTEGER             NOT NULL,
  reason     TEXT                NOT NULL,
  set_by     VARCHAR(255)        NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

  CONSTRAINT customization_quota_overrides_quota_key_chk
    CHECK (quota_key IN ('fields_per_domain', 'options_per_picklist', 'show_on_related_fields')),
  CONSTRAINT customization_quota_overrides_value_chk
    CHECK (value > 0),
  CONSTRAINT customization_quota_overrides_reason_chk
    CHECK (length(btrim(reason)) > 0)
);

CREATE UNIQUE INDEX customization_quota_overrides_org_key_domain_uniq
  ON customization_quota_overrides (org_id, quota_key, domain)
  WHERE domain IS NOT NULL;

CREATE UNIQUE INDEX customization_quota_overrides_org_key_global_uniq
  ON customization_quota_overrides (org_id, quota_key)
  WHERE domain IS NULL;

ALTER TABLE customization_quota_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE customization_quota_overrides FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customization_quota_overrides
  USING (org_id = app_current_organization_id());

-- Read-only for the app role: overrides are granted exclusively by the
-- super-admin surface through the owner pool (`systemDb`). The ALTER
-- DEFAULT PRIVILEGES from migration 0005 auto-grants full CRUD to
-- `givernance_app` on every new table, so the write bits must be
-- revoked explicitly — the GRANT alone would be a no-op.
GRANT SELECT ON customization_quota_overrides TO givernance_app;
REVOKE INSERT, UPDATE, DELETE ON customization_quota_overrides FROM givernance_app;

CREATE TABLE custom_field_merge_undo (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  definition_id    UUID        NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  merge_id         UUID        NOT NULL,
  source_option_id VARCHAR(20) NOT NULL,
  target_option_id VARCHAR(20) NOT NULL,
  entity_id        UUID        NOT NULL,
  previous_value   JSONB       NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL
);

-- Undo path: fetch every row of one merge operation for a tenant.
CREATE INDEX custom_field_merge_undo_org_merge_idx
  ON custom_field_merge_undo (org_id, merge_id);

-- Purge-cron scan key.
CREATE INDEX custom_field_merge_undo_expiry_idx
  ON custom_field_merge_undo (expires_at);

ALTER TABLE custom_field_merge_undo ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_merge_undo FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON custom_field_merge_undo
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_merge_undo TO givernance_app;
