-- Migration: 0046_bulk_email_jobs_review_followups (issue #326 — PR #352 multi-agent review fixes)
--
-- Three tightenings landed off the back of the platform + security review
-- on PR #352. All three are idempotent and additive — they take effect on
-- the next deploy without operator intervention.
--
--   1. **Composite covering index for the list query.** The Phase-1 access
--      pattern `WHERE org_id = ? AND deleted_at IS NULL ORDER BY created_at
--      DESC LIMIT 20` (`listBulkEmailJobs`) can't be satisfied by the two
--      single-column indexes added in 0044 — Postgres falls back to a
--      filter-then-sort. Fine at MVP cardinality, but the partial composite
--      below collapses the path to one index scan and drops the standalone
--      `created_at` index whose only consumer is this same query.
--
--   2. **Partial unique index on `parent_job_id` for active resumes.**
--      Belt-and-braces companion to the `SELECT … FOR UPDATE` lock that
--      `resumeBulkEmailJob` now takes. Two simultaneous resume calls
--      against the same source can no longer both succeed — even if the
--      row lock is somehow bypassed (raw SQL, future direct-DB tooling),
--      this index makes a duplicate `INSERT` fail at the DB layer with a
--      unique-violation rather than silently producing two child rows
--      that both fan out to the same remaining recipients. (Security
--      review H1 / Platform review H1.)
--
--      Partial-only because resume rows are short-lived in the non-
--      terminal state — once status flips to `completed` / `partial` /
--      `failed`, a future resume from the same parent is legitimate and
--      mustn't be blocked by an old index entry.

-- ─── 1. Composite covering index ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS bulk_email_jobs_org_created_at_active_idx
  ON bulk_email_jobs (org_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- The standalone `created_at` index from 0044 was only used by the listing
-- path that the composite above now serves. Drop it to keep INSERT cost
-- low (every INSERT writes to every index).
DROP INDEX IF EXISTS bulk_email_jobs_created_at_idx;

-- ─── 2. Partial unique on active resumes ──────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS bulk_email_jobs_one_active_resume_per_parent
  ON bulk_email_jobs (parent_job_id)
  WHERE parent_job_id IS NOT NULL
    AND status IN ('pending', 'processing');
