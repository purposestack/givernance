-- Migration: 0079_platform_finance_reports (Epic #434 follow-up, issue #443)
--
-- Tracks the monthly PDF finance reports generated for the super-admin
-- "Finance plateforme" dashboard (route `POST /v1/superadmin/finance/
-- reports/monthly`).
--
-- One row per (month, attempt). The report covers the most recent
-- fully-completed calendar month — generated on demand by a
-- super-admin clicking "Rapport mensuel". A `status='ready'` or
-- `status='pending'` row makes the same-month re-submit idempotent:
-- the route returns the existing row instead of re-enqueuing a job.
-- A `status='failed'` row does NOT block a fresh attempt — the
-- partial unique index below scopes the constraint to the live
-- statuses only.
--
-- PLATFORM-LEVEL TABLE: no `org_id`, no RLS. Reports aggregate
-- cross-tenant finance data (`donations.platform_fee_base_cents`,
-- `donations.stripe_fee_cents`, Mobilisation Score per tenant) and
-- are authored / consumed by super-admins exclusively. Accessed
-- through `systemDb` (BYPASSRLS owner pool); REVOKE on
-- `givernance_app` so an accidental query through the tenant-scoped
-- pool fails loud.
--
-- `month` is the YYYY-MM label of the period the report covers.
-- CHECK-constrained to a real calendar month so a malformed value
-- (e.g. `2026-13`) can't reach the worker.
--
-- `pdf_s3_key` is the path inside `S3_REPORTS_BUCKET` (private,
-- streamed back through the API per the streaming-through-API
-- convention from issue #214). NULL until the worker uploads.
--
-- `kpi_snapshot` is the full `SummaryServiceResult` payload that
-- powered the PDF, frozen at generation time. Lets the future "PDF
-- viewer" + GDPR Art. 5(2) accountability ("what numbers did the
-- super-admin actually see?") work without re-running the SQL.
--
-- `requested_by_platform_admin_id` is the super-admin who clicked
-- the button — feeds the per-generate audit_log row.

CREATE TABLE platform_finance_reports (
  id                              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- YYYY-MM label of the calendar month the report covers.
  month                           CHAR(7)      NOT NULL,
  -- 'pending' until the worker finishes, then 'ready' (or 'failed').
  status                          TEXT         NOT NULL DEFAULT 'pending',
  pdf_s3_key                      TEXT,
  kpi_snapshot                    JSONB,
  failure_reason                  TEXT,
  requested_by_platform_admin_id  UUID         REFERENCES platform_admins(id) ON DELETE SET NULL,
  -- BullMQ job id (`monthly-finance-report-<id>`), kept for the
  -- `/finance/reports/:id` polling lookup so the API can hint at
  -- BullMQ state when the row is still `pending` after several
  -- minutes (DLQ candidate signal).
  job_id                          TEXT,
  created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ready_at                        TIMESTAMPTZ,

  CONSTRAINT platform_finance_reports_month_chk
    CHECK (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT platform_finance_reports_status_chk
    CHECK (status IN ('pending', 'ready', 'failed'))
);

-- Partial unique on `month` scoped to live statuses — same month +
-- (pending|ready) collapses to a single row (idempotent POST). A
-- prior `failed` row does not block a fresh attempt; the API filters
-- by `status IN ('pending','ready')` when checking for an existing
-- report.
CREATE UNIQUE INDEX platform_finance_reports_month_live_uniq
  ON platform_finance_reports (month)
  WHERE status IN ('pending', 'ready');

CREATE INDEX platform_finance_reports_status_idx
  ON platform_finance_reports (status);

CREATE INDEX platform_finance_reports_month_idx
  ON platform_finance_reports (month DESC);

REVOKE ALL ON platform_finance_reports FROM givernance_app;
