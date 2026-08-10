-- Migration 0061: Add org_currency_balances table (ADR-032 §2.10, Epic #416 Task 6)
--
-- Materialized running totals per (org, currency) pair. Updated by the
-- update-org-currency-balance worker processor on donation.created /
-- donation.refunded / donation.status_changed outbox events.
--
-- Totals are BIGINT cents: these are CUMULATIVE LIFETIME running totals, so a
-- mid/large NPO realistically overflows INTEGER (cap ≈ €21.4M). BIGINT keeps the
-- integer-cents money model used everywhere else while removing the ceiling.

CREATE TABLE org_currency_balances (
  org_id               UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  currency             VARCHAR(3)  NOT NULL,
  cleared_total_cents  BIGINT      NOT NULL DEFAULT 0,
  pending_total_cents  BIGINT      NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, currency)
);

CREATE INDEX org_currency_balances_org_idx ON org_currency_balances (org_id);

-- RLS: tenant isolation (read path via givernance_app).
-- FORCE so the table-owner role (which runs the worker upsert) is also subject to
-- the policy — defence in depth, consistent with 0012_force_rls.sql and every
-- tenant table since. Uses the app_current_organization_id() helper rather than a
-- raw current_setting(...)::uuid cast so an empty-string GUC can never raise the
-- 22P02 invalid-input-syntax-for-uuid crash that 0020_rls_empty_string_fix.sql killed.
ALTER TABLE org_currency_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_currency_balances FORCE ROW LEVEL SECURITY;

CREATE POLICY org_currency_balances_tenant_isolation ON org_currency_balances
  USING (org_id = app_current_organization_id());

-- The worker upsert runs via the owner pool (systemDb / BYPASSRLS); tenant users
-- only need SELECT for the reporting API surface.
GRANT SELECT ON org_currency_balances TO givernance_app;
