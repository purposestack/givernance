-- Migration: 0051_feature_flags_phase2 (Epic #365 / PR #366)
--
-- Phase 2 of the feature-flag system per `docs/18-feature-flags.md`
-- §§ 4.2, 5, 9 — flips the deferred rows in § 0 from ❌ to ✅. This
-- migration is structural only (schema + seeds); the evaluator +
-- routes + UI land in subsequent commits on the same PR.
--
-- Three structural moves bundled together because they all have to
-- be observable before the new evaluator can be safely deployed:
--
--   1. Three new columns on `feature_flags`:
--      * `scope`                    enum: 'platform' | 'tenant'
--      * `tenant_override_allowed`  bool — extra gate on tenant-scoped
--        flags so super-admin can still hold deliverability-blocked
--        rows even when their `scope` says 'tenant'.
--      * `public`                   bool — controls whether the
--        `/v1/feature-flags` projection emits this row to non-admin
--        tenant callers. Resolves the public-projection caveat from
--        doc 18 § 0 (the key name itself was leaking).
--
--   2. New `tenant_flag_overrides` table per doc 18 § 4.2. RLS enabled
--      and forced so an org_admin can never read another tenant's
--      overrides. UNIQUE (tenant_id, flag_key) so the upsert
--      semantics in `PUT /admin/tenants/:id/feature-flags/:key` are
--      single-row atomic.
--
--   3. Backfill the existing `communication.bulk_email` row with the
--      conservative defaults: `scope='platform'` (DKIM/SPF/DMARC is a
--      platform precondition, not a per-tenant preference),
--      `tenant_override_allowed=false`, `public=true` (the tenant UI
--      already reads it to hide the bulk-email button).
--
-- Idempotent — every step uses `IF NOT EXISTS` / unconditional UPDATE.
-- Re-running on a fresh checkout is a no-op. Per
-- `feedback_never_modify_applied_migrations`, this is a NEW migration
-- file — 0047 / 0049 stay untouched.

-- ─── 1. Add `scope` / `tenant_override_allowed` / `public` to feature_flags ──
--
-- All three nullable + defaulted at first so the existing rows pick
-- up the conservative platform-default-deny posture without an
-- explicit backfill window. Step 3 explicitly sets the existing
-- bulk-email row to its intended values; step 4 promotes the columns
-- to NOT NULL once every row is filled.

DO $$
BEGIN
  CREATE TYPE feature_flag_scope AS ENUM ('platform', 'tenant');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS scope feature_flag_scope NOT NULL DEFAULT 'platform';

ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS tenant_override_allowed BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE feature_flags
  ADD COLUMN IF NOT EXISTS public BOOLEAN NOT NULL DEFAULT FALSE;

-- ─── 2. Create `tenant_flag_overrides` ──────────────────────────────────────
--
-- Per doc 18 § 4.2. `(tenant_id, flag_key)` is the natural upsert
-- key. `reason` is operator-facing free-text — the audit_log row
-- captures the actor; this column captures the WHY ("Beta-tested
-- with this NPO on 2026-04 standup", etc.).
--
-- `expires_at` is part of the schema but un-UI'd in this Epic per
-- doc 18 § 4.2 — a follow-up Epic can ship the auto-expire worker.

CREATE TABLE IF NOT EXISTS tenant_flag_overrides (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flag_key    VARCHAR(100) NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE ON UPDATE CASCADE,
  value       BOOLEAN      NOT NULL,
  -- `set_by` SET NULLs on user purge so a GDPR-erased operator
  -- doesn't FK-block the row. Audit history lives in `audit_logs`.
  set_by      UUID         REFERENCES users(id) ON DELETE SET NULL,
  reason      TEXT,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT  tenant_flag_overrides_unique UNIQUE (tenant_id, flag_key)
);

-- Indices to support: (a) listing every override for a tenant
-- (super-admin tenant-detail tab + org-admin self-service page),
-- (b) counting overrides per flag for the global view's
-- `overrideStats` column.
CREATE INDEX IF NOT EXISTS tenant_flag_overrides_tenant_idx
  ON tenant_flag_overrides (tenant_id);

CREATE INDEX IF NOT EXISTS tenant_flag_overrides_flag_idx
  ON tenant_flag_overrides (flag_key);

-- ─── 2b. RLS — force tenant isolation ───────────────────────────────────────
--
-- `tenant_flag_overrides` is tenant-scoped: every row belongs to
-- exactly one tenant. The policy mirrors the rest of the tenant-
-- scoped tables: row visible iff `tenant_id = app_current_organization_id()`.
--
-- Super-admin access goes through the owner role (BYPASSRLS) per
-- ADR-021, so platform endpoints (which use the owner connection)
-- see every row; tenant-facing endpoints use `givernance_app`
-- (NOBYPASSRLS) and get the tenant's slice.

ALTER TABLE tenant_flag_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_flag_overrides FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_flag_overrides_tenant_isolation ON tenant_flag_overrides;
CREATE POLICY tenant_flag_overrides_tenant_isolation ON tenant_flag_overrides
  FOR ALL
  TO givernance_app
  USING (tenant_id = app_current_organization_id())
  WITH CHECK (tenant_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_flag_overrides TO givernance_app;

-- ─── 3. Backfill `communication.bulk_email` + seed `admin.feature_flags_phase2` ──
--
-- The default of the new columns made every existing row
-- `scope='platform' / tenant_override_allowed=false / public=false`.
-- That's correct for the *posture* of `communication.bulk_email`
-- (DKIM/SPF/DMARC is a platform precondition) BUT `public` must be
-- TRUE for that row because the tenant UI already reads
-- `/v1/feature-flags` to hide the bulk-email button on the
-- constituents page. Flipping it to private would break that UI.
--
-- Seeding `admin.feature_flags_phase2` from THIS migration (rather
-- than relying on a future startup-time idempotent seed) matches
-- the 0047 pattern: the migration is the canonical seed step.
-- `FEATURE_FLAG_REGISTRY` carries the operator-facing
-- label/description strings; the parity integration test asserts
-- that the row below matches them. Drift fails CI.
--
-- `admin.feature_flags_phase2` is `public=TRUE` because the
-- org-admin self-service page renders a sidebar entry whose
-- visibility is decided by an SSR read of `/v1/feature-flags`. A
-- private flag here would make the sidebar entry unconditionally
-- hidden for org-admin users, defeating the Epic's primary surface.

UPDATE feature_flags
SET
  scope = 'platform',
  tenant_override_allowed = FALSE,
  public = TRUE,
  updated_at = NOW()
WHERE key = 'communication.bulk_email';

INSERT INTO feature_flags (key, enabled, label, description, scope, tenant_override_allowed, public)
VALUES (
  'admin.feature_flags_phase2',
  FALSE,
  'Per-organisation feature flag controls',
  'Lets Givernance staff turn features on or off for one organisation at a time, and lets each organisation''s admin manage their own feature settings from the Settings menu. Off by default until the new pages have been verified end-to-end.',
  'platform',
  FALSE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;

-- ─── 4. Composite index for the public projection ──────────────────────────
--
-- `GET /v1/feature-flags` now filters by `public = TRUE` then
-- returns `(key, enabled)`. A partial index on `WHERE public = TRUE`
-- keeps that hot path off a full-table scan even as the registry
-- grows.

CREATE INDEX IF NOT EXISTS feature_flags_public_idx
  ON feature_flags (key)
  WHERE public = TRUE;
