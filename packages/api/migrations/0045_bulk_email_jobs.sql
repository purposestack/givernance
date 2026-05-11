-- Migration: 0045_bulk_email_jobs (issue #326)
--
-- Bulk-email jobs — partial-send indicator + resume path for the
-- `communication.bulk_email_requested` outbox flow.
--
-- Today the outbox relay (packages/relay/src/relay.ts) marks the row
-- `completed` the moment it enqueues the BullMQ job (at-most-once
-- enqueue, by design — see ADR-026 § "Redis 8 cutover" for why this
-- matters around a Redis wipe). When the worker dies mid-fan-out
-- (Redis OOM, accessory reboot, operator-initiated wipe), the
-- operator-facing UI today reads "send succeeded" even if zero
-- recipients were reached. Two consequences:
--
--   1. GDPR transparency — the tenant operator has a right to know how
--      many recipients were actually delivered (Art. 5(1)(b)).
--   2. Operational — there's no re-issuance path. The operator would
--      have to manually re-export the recipient list and re-trigger.
--
-- This migration adds the queryable progress + resume surface:
--
--   - `bulk_email_jobs` row inserted in the same transaction as the
--     outbox event (same tx the donation/receipt/postal-export flows
--     already follow). Carries the request snapshot + per-recipient
--     outcome arrays so the resume path can compute "remaining =
--     constituent_ids \ delivered_constituent_ids" without scanning a
--     separate event log.
--
--   - Worker increments `delivered_count` / `failed_count` and
--     appends to the corresponding id array on each send, so the
--     polling UI sees a live ratio. On worker process death mid-job,
--     the row stays at its last update — the operator sees "5 of 10
--     delivered, processing (stalled)" and can hit Resume.
--
--   - Resume creates a fresh `bulk_email_jobs` row with
--     `parent_job_id = source.id` and `constituent_ids = source
--     remaining`, then emits a new outbox event. The audit chain is
--     queryable via `parent_job_id`.
--
-- RLS: standard tenant_isolation policy. Worker reads + writes go
-- through `withWorkerContext`; API reads + writes through
-- `withTenantContext`.
--
-- Idempotent — re-runs on a fresh checkout are no-ops.

-- ─── Enum ───────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE bulk_email_job_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'partial',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bulk_email_jobs (
  id                          UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID                  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  status                      bulk_email_job_status NOT NULL DEFAULT 'pending',
  subject                     VARCHAR(200)          NOT NULL,
  body                        TEXT                  NOT NULL,
  -- Snapshot of deliverable recipients at request time. Locked at
  -- insert; worker iterates this list. uuid[] (not jsonb) so Postgres
  -- can do `= ANY(...)` / `ARRAY(SELECT unnest(...) EXCEPT ...)`
  -- without a cast on every read.
  constituent_ids             UUID[]                NOT NULL,
  -- Append-only set of recipients the worker successfully delivered to.
  -- Default '{}' so the worker's first UPDATE can rely on the column.
  delivered_constituent_ids   UUID[]                NOT NULL DEFAULT '{}',
  -- Append-only set of recipients the worker tried and SMTP refused.
  failed_constituent_ids      UUID[]                NOT NULL DEFAULT '{}',
  -- Denormalised counts so the polling UI is O(1). Worker keeps them
  -- in step with the array cardinality on every send.
  total_recipients            INTEGER               NOT NULL,
  delivered_count             INTEGER               NOT NULL DEFAULT 0,
  failed_count                INTEGER               NOT NULL DEFAULT 0,
  -- JWT subject → internal users.id translation. SET NULL on user
  -- purge so GDPR erasure of a staff account doesn't FK-block the
  -- audit row.
  requested_by                UUID                  REFERENCES users(id) ON DELETE SET NULL,
  -- Audit chain for resume jobs. NULL on the originating dispatch.
  parent_job_id               UUID                  REFERENCES bulk_email_jobs(id) ON DELETE SET NULL,
  -- Terminal failure message. NULL until status flips to `failed`.
  error                       TEXT,
  -- Soft-delete (ADR-021 universal).
  deleted_at                  TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ           NOT NULL DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  -- Defence-in-depth: keep the counters in step with the arrays. The
  -- worker's UPDATE statement uses array_length to set them, but a
  -- raw-SQL backfill or a buggy migration could drift them — the
  -- CHECK fails loudly instead of silently misreporting "8 of 10".
  CONSTRAINT bulk_email_jobs_counts_match_arrays_chk CHECK (
    delivered_count = COALESCE(array_length(delivered_constituent_ids, 1), 0)
    AND failed_count = COALESCE(array_length(failed_constituent_ids, 1), 0)
    AND total_recipients = COALESCE(array_length(constituent_ids, 1), 0)
  )
);

CREATE INDEX IF NOT EXISTS bulk_email_jobs_org_idx
  ON bulk_email_jobs (org_id);
CREATE INDEX IF NOT EXISTS bulk_email_jobs_created_at_idx
  ON bulk_email_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS bulk_email_jobs_parent_idx
  ON bulk_email_jobs (parent_job_id);

ALTER TABLE bulk_email_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_email_jobs FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON bulk_email_jobs
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON bulk_email_jobs TO givernance_app;
