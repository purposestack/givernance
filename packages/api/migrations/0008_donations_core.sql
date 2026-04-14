-- Migration: 0008_donations_core
-- Creates funds, donation_allocations, pledges, and pledge_installments tables
-- with RLS tenant isolation policies.

-- ─── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE fund_type AS ENUM ('restricted', 'unrestricted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE pledge_frequency AS ENUM ('monthly', 'yearly');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE pledge_status AS ENUM ('active', 'paused', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE installment_status AS ENUM ('pending', 'paid', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Indexes on existing donations table ────────────────────────────────────

CREATE INDEX IF NOT EXISTS donations_org_id_idx ON donations (org_id);
CREATE INDEX IF NOT EXISTS donations_constituent_id_idx ON donations (constituent_id);
CREATE INDEX IF NOT EXISTS donations_donated_at_idx ON donations (donated_at);

-- ─── Funds ──────────────────────────────────────────────────────────────────

CREATE TABLE funds (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  type        fund_type    NOT NULL DEFAULT 'unrestricted',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX funds_org_id_idx ON funds (org_id);

ALTER TABLE funds ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON funds
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- ─── Donation Allocations ───────────────────────────────────────────────────

CREATE TABLE donation_allocations (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  donation_id   UUID    NOT NULL REFERENCES donations(id) ON DELETE CASCADE,
  fund_id       UUID    NOT NULL REFERENCES funds(id) ON DELETE RESTRICT,
  amount_cents  INTEGER NOT NULL
);

CREATE INDEX donation_allocations_org_id_idx ON donation_allocations (org_id);
CREATE INDEX donation_allocations_donation_id_idx ON donation_allocations (donation_id);
CREATE INDEX donation_allocations_fund_id_idx ON donation_allocations (fund_id);

ALTER TABLE donation_allocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON donation_allocations
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- ─── Pledges ────────────────────────────────────────────────────────────────

CREATE TABLE pledges (
  id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID             NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  constituent_id      UUID             NOT NULL REFERENCES constituents(id),
  amount_cents        INTEGER          NOT NULL,
  currency            VARCHAR(3)       NOT NULL DEFAULT 'EUR',
  frequency           pledge_frequency NOT NULL,
  status              pledge_status    NOT NULL DEFAULT 'active',
  stripe_customer_id  VARCHAR(255),
  stripe_account_id   VARCHAR(255),
  payment_gateway     VARCHAR(50),
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX pledges_org_id_idx ON pledges (org_id);
CREATE INDEX pledges_constituent_id_idx ON pledges (constituent_id);

ALTER TABLE pledges ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pledges
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- ─── Pledge Installments ────────────────────────────────────────────────────

CREATE TABLE pledge_installments (
  id                  UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID               NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  pledge_id           UUID               NOT NULL REFERENCES pledges(id) ON DELETE CASCADE,
  donation_id         UUID               REFERENCES donations(id) ON DELETE SET NULL,
  expected_at         TIMESTAMPTZ        NOT NULL,
  installment_status  installment_status NOT NULL DEFAULT 'pending',
  created_at          TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ        NOT NULL DEFAULT NOW()
);

CREATE INDEX pledge_installments_org_id_idx ON pledge_installments (org_id);
CREATE INDEX pledge_installments_pledge_id_idx ON pledge_installments (pledge_id);

ALTER TABLE pledge_installments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON pledge_installments
  USING (org_id = current_setting('app.current_org_id', true)::UUID);

-- ─── Grant permissions to app role ──────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON funds TO givernance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON donation_allocations TO givernance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pledges TO givernance_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON pledge_installments TO givernance_app;
