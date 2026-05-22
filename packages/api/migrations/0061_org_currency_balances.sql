-- Migration 0061: Add org_currency_balances table (ADR-031 §2.10, Epic #416 Task 6)
--
-- Materialized running totals per (org, currency) pair. Updated by the
-- update-org-currency-balance worker processor on donation.created /
-- donation.refunded / donation.status_changed outbox events.

CREATE TABLE org_currency_balances (
  org_id               UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  currency             VARCHAR(3)  NOT NULL,
  cleared_total_cents  INTEGER     NOT NULL DEFAULT 0,
  pending_total_cents  INTEGER     NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, currency)
);

CREATE INDEX org_currency_balances_org_idx ON org_currency_balances (org_id);

-- RLS: tenant isolation (read path via givernance_app)
ALTER TABLE org_currency_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_currency_balances_tenant_isolation ON org_currency_balances
  USING (org_id = current_setting('app.current_organization_id', true)::uuid);

-- The worker upsert runs via the owner role (BYPASSRLS); tenant users
-- only need SELECT for the reporting API surface.
GRANT SELECT ON org_currency_balances TO givernance_app;
