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

-- The operator-facing `label` column is added later (migration 0049 —
-- introduced after the magino UX review revealed the row was too
-- technical for non-engineers). We don't backport the column into
-- THIS migration because it may already have been applied in dev /
-- staging — modifying an applied migration is a silent no-op
-- under `CREATE TABLE IF NOT EXISTS`, leaving the DB in a drifted
-- state that breaks the route. Migrations are immutable once
-- applied anywhere.

-- (No explicit `feature_flags_key_idx` — the `UNIQUE` constraint on
-- `key` already creates a btree index that satisfies the
-- `WHERE key = ?` access pattern in `flagService` + `requireFlag`.
-- PR #352 Platform review Plat-LOW-2a flagged the redundant index.)

-- No RLS — the registry is platform-wide, not tenant-scoped. The
-- `requireSuperAdmin` guard on the admin routes is the access boundary.
--
-- GRANTs intentionally narrow: `INSERT` is reserved for the seed
-- migration (running as the owner role); the admin PATCH handler
-- only UPDATEs an existing row, never INSERTs. DELETE is never
-- granted — flag deletion is a code change + a follow-up migration,
-- not a runtime operation. (PR #352 Platform review Plat-LOW-2b.)
GRANT SELECT, UPDATE ON feature_flags TO givernance_app;

-- ─── Seed ───────────────────────────────────────────────────────────────────
-- Seed the bulk-email row. The `description` here is the initial-
-- engineering-rationale version; migration 0049 rewrites it to the
-- operator-friendly text and adds the `label` column. Kept this way
-- to honour the "migrations are immutable once applied" rule.

INSERT INTO feature_flags (key, enabled, description)
VALUES (
  'communication.bulk_email',
  FALSE,
  'Operator-triggered bulk email to selected constituents (issue #326). Disabled until the platform''s outbound mail domain has DKIM / SPF / DMARC configured — without them every send looks like phishing to recipient MX servers.'
)
ON CONFLICT (key) DO NOTHING;
