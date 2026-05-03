-- Migration: 0036_platform_admins_sort_indexes
--
-- ADR-022 follow-up (issue #255, data-architect M4).
--
-- The platform-admin list endpoint (`GET /v1/admin/platform-admins`)
-- accepts `sort=lastName|email|createdAt|lastLoginAt` and currently
-- sequential-scans `platform_admins` for any sort other than `email`
-- (which rides the existing `platform_admins_email_active_uniq`
-- partial-unique index). The other three sort fields had no index,
-- so the planner falls back to seq scan + sort even on the small
-- expected row counts — fine for Phase 1 staff (≤ 50 rows) but the
-- ordering invariant should be index-backed before any production
-- deploy adds operational scale.
--
-- Indexes:
--   * `last_name` ASC (matches the default-secondary sort and the
--     directory-style listing the admin UI defaults to).
--   * `created_at DESC` (matches the default sort key in the route
--     handler when `sort` is omitted).
--   * `last_login_at` (mixed asc/desc usage; index orientation
--     defaults to ASC, NULLs last on the DESC scan side).
--
-- All three are partial on `deleted_at IS NULL` to mirror the existing
-- unique-index posture: the active-only listing is the hot path, the
-- include-deleted path is rare and can seq-scan. Partial indexes also
-- keep the index size bounded by active-row count rather than ever-
-- growing audit history.

CREATE INDEX IF NOT EXISTS platform_admins_last_name_active_idx
  ON platform_admins (last_name)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS platform_admins_created_at_active_idx
  ON platform_admins (created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS platform_admins_last_login_at_active_idx
  ON platform_admins (last_login_at)
  WHERE deleted_at IS NULL;
