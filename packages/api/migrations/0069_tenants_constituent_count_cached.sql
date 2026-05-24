-- Migration: 0069_tenants_constituent_count_cached (Epic #434, issue #435)
--
-- Caches the per-tenant constituent count on the `tenants` row itself
-- so the super-admin dashboard's TopTenantsList + tenant-health table
-- can render without firing `COUNT(constituents) GROUP BY org_id` over
-- the whole platform on every page load. With 100+ tenants the N+1
-- COUNT pattern is the slowest single query in the whole dashboard
-- payload and dominates the p95 latency budget.
--
-- Refresh contract (worker job, SUB-WORKER #436):
--   * A daily CRON job (BullMQ repeatable, 04:00 UTC) iterates every
--     non-archived tenant, runs `COUNT(*) FROM constituents WHERE
--     org_id = ? AND deleted_at IS NULL` via `systemDb` (CROSS-TENANT
--     INTENTIONAL — the worker is platform-scope), and writes both
--     columns. The DELETE/INSERT path on `constituents` does NOT
--     update this column synchronously — the cache is allowed to drift
--     by up to 24h, surfaced to the operator by the `fresh-pip` pattern
--     ("dernière mise à jour il y a Nh") on the dashboard tile.
--
-- `constituent_count_cached INTEGER NOT NULL DEFAULT 0` so a newly
-- provisioned tenant immediately renders 0 (correct value) until the
-- next cron tick refreshes; no NULL-handling in the read path.
--
-- `constituent_count_refreshed_at TIMESTAMPTZ NULL` so the dashboard
-- can render "jamais actualisé" for a brand-new tenant the first time
-- a super-admin opens the page before the cron has run. NULL is
-- semantically distinct from "refreshed-and-then-staled" and the UI
-- treats the two differently.

ALTER TABLE tenants
  ADD COLUMN constituent_count_cached INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN constituent_count_refreshed_at TIMESTAMPTZ;
