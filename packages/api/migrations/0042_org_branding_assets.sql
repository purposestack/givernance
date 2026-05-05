-- 0042 — Org branding assets (Epic #286).
--
-- Polymorphic table that stores every "brand-like" asset an organisation
-- uploads. Today the only producer is the org-logo upload flow; the
-- table is shaped to grow into donation-page hero, favicon, letterhead
-- PDF, etc. without a structural rewrite.
--
-- Why a separate table (not extra columns on `tenants`):
--   - One tenant can hold a small library of branding assets across
--     surfaces (sidebar logo, donation-page hero, PDF letterhead). Each
--     has its own variant matrix and async-processing lifecycle.
--   - Asset rows are append-only-ish (status flips, then soft-delete);
--     `tenants` stays small + cacheable.
--   - The active pointer lives on `tenants.logo_asset_id` (FK with
--     ON DELETE SET NULL) — flipping which asset is "live" is a single
--     UPDATE, no need to mutate any binary on disk.
--
-- Lifecycle:
--   pending  → API handler validated upload, wrote original to S3.
--   ready    → worker derived 4 variants and uploaded them; row is
--              eligible for the `tenants.logo_asset_id` activation step.
--   failed   → worker rejected the upload (sharp parse error, oversize,
--              unsafe SVG sniffed post-sanitise). UI surfaces `error`.
--
-- RLS: standard `tenant_isolation` pattern keyed on `org_id`. Reads
-- happen exclusively through `withTenantContext` / `withWorkerContext`.
--
-- Idempotent — re-running on a fresh checkout is a no-op.

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS org_branding_assets (
  id                      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Discriminator. Today: `org_logo`. Adding new types is an in-place enum
  -- extension; no policy or index changes required.
  asset_type              VARCHAR(32)  NOT NULL,
  -- Lifecycle: pending → ready → failed. Worker drives transitions.
  status                  VARCHAR(16)  NOT NULL DEFAULT 'pending',
  -- S3 key (relative to the branding bucket) of the raw upload. SVGs are
  -- stored sanitised (DOMPurify) but otherwise identical to what the
  -- operator sent. Rasters are EXIF-stripped on the worker side.
  original_key            VARCHAR(500) NOT NULL,
  -- Magic-byte-validated MIME of the original upload.
  original_content_type   VARCHAR(64)  NOT NULL,
  -- Original byte size (jsonb on the Drizzle side because integer-jsonb
  -- gives consistent serialisation across nullable fields without an
  -- explicit nullable INT column; the migration declares it as JSONB to
  -- match).
  original_bytes          JSONB,
  -- Worker-derived variants. Keyed by BrandingVariantKey (string union).
  -- NULL until the worker flips status='ready'. JSONB (not a child table)
  -- because the variant set is fixed-shape and never queried in isolation.
  variants                JSONB,
  -- Source (raster) dimensions captured during validation. Useful for
  -- the audit trail (helps an operator understand "the upload worked
  -- but the picture is too small to render crisply").
  source_width            JSONB,
  source_height           JSONB,
  -- Captured error message on terminal failure. Surfaced to the admin UI
  -- as a generic toast; the structured worker logs carry the stack.
  error                   TEXT,
  -- Uploader id (KC sub or app user id). VARCHAR (not UUID FK) so a
  -- subsequent KC erasure doesn't break audit reconstruction.
  uploaded_by             VARCHAR(255),
  -- Soft-delete marker. The `branding.gc_asset` worker job runs after
  -- this is set to remove the S3 prefix and clear the KC org attribute.
  deleted_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_branding_org_id
  ON org_branding_assets (org_id);

-- Partial covering index for the "active asset of type T for org O"
-- lookup (the most frequent read pattern from the GET endpoint).
-- Filters out soft-deleted rows so the planner skips dead asset
-- generations entirely.
CREATE INDEX IF NOT EXISTS idx_branding_org_type
  ON org_branding_assets (org_id, asset_type)
  WHERE deleted_at IS NULL;

-- ─── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE org_branding_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_branding_assets FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON org_branding_assets
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON org_branding_assets TO givernance_app;

-- ─── tenants.logo_asset_id ─────────────────────────────────────────────────
--
-- Pointer to the currently-active branding logo. Flipped by the
-- `branding.activate_logo` worker job after the pipeline flips the
-- asset to status='ready'. NULL = no logo configured.
--
-- ON DELETE SET NULL so a hard-deleted asset row leaves the tenant
-- pointer dangling-clear, never broken. (We soft-delete in the normal
-- path; this is defense-in-depth for any future hard-delete admin tool.)

DO $$ BEGIN
  ALTER TABLE tenants
    ADD COLUMN logo_asset_id UUID REFERENCES org_branding_assets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
