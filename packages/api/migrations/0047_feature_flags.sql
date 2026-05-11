-- Migration: 0047_feature_flags (issue #326 / PR #352 follow-up)
--
-- Adds the global feature-flag registry that gates the bulk-email work
-- behind a platform-admin toggle. Scope is intentionally narrow per the
-- @magino discussion on PR #352:
--
--   * **Global flags only.** Every tenant sees the same value. Per-
--     tenant overrides + plan-gating from `docs/18-feature-flags.md`
--     §4.2-4.3 are deferred until we actually have a use-case for them.
--   * **Code is the source of truth for which keys exist** —
--     `packages/shared/src/constants/feature-flags.ts` declares
--     `FEATURE_FLAG_REGISTRY`; this migration seeds those keys with
--     their default values. The admin UI toggles `enabled`, it does
--     NOT create rows.
--
-- The bulk-email flag (`communication.bulk_email`) is seeded with
-- `enabled = FALSE` — see the doc-18 / doc-23 cross-reference for the
-- DKIM / SPF rationale.
--
-- Idempotent — `IF NOT EXISTS` on the table, `ON CONFLICT (key) DO
-- NOTHING` on the seed so a redeploy preserves any operator-toggled
-- value.

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS feature_flags (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Dotted-namespace key. Lowercase + dot-separated; the application
  -- layer enforces the convention via the typed `FeatureFlagKey`
  -- union. UNIQUE because `requireFlag(key)` looks up by this column.
  key          VARCHAR(100) NOT NULL UNIQUE,
  enabled      BOOLEAN      NOT NULL DEFAULT FALSE,
  description  TEXT         NOT NULL,
  -- Last super-admin to flip the flag. SET NULL on user purge so a
  -- GDPR-erased staff account doesn't FK-block the row.
  updated_by   UUID         REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS feature_flags_key_idx
  ON feature_flags (key);

-- No RLS — the registry is platform-wide, not tenant-scoped. The
-- `requireSuperAdmin` guard on the admin routes is the access boundary.
GRANT SELECT, INSERT, UPDATE ON feature_flags TO givernance_app;

-- ─── Seed ───────────────────────────────────────────────────────────────────
-- Keep the SQL `description` in lockstep with the
-- `FEATURE_FLAG_REGISTRY` entry in
-- `packages/shared/src/constants/feature-flags.ts`. The startup check
-- (boot helper) compares the two and fails fast on drift.

INSERT INTO feature_flags (key, enabled, description)
VALUES (
  'communication.bulk_email',
  FALSE,
  'Operator-triggered bulk email to selected constituents (issue #326). Disabled until the platform''s outbound mail domain has DKIM / SPF / DMARC configured — without them every send looks like phishing to recipient MX servers.'
)
ON CONFLICT (key) DO NOTHING;
