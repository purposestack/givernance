-- Migration: 0003_constituents_donations
-- Creates constituents and donations tables (missing from prior migrations)

-- ─── Constituents ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS constituents (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID         NOT NULL,
  first_name  VARCHAR(255) NOT NULL,
  last_name   VARCHAR(255) NOT NULL,
  email       VARCHAR(255),
  phone       VARCHAR(50),
  type        VARCHAR(50)  NOT NULL DEFAULT 'donor',
  tags        TEXT[],
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Donations ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS donations (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID         NOT NULL,
  constituent_id  UUID         NOT NULL REFERENCES constituents(id),
  amount_cents    INTEGER      NOT NULL,
  currency        VARCHAR(3)   NOT NULL DEFAULT 'EUR',
  campaign_id     UUID,
  payment_method  VARCHAR(50),
  payment_ref     VARCHAR(255),
  donated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  fiscal_year     INTEGER,
  receipt_number  VARCHAR(100),
  receipt_amount  NUMERIC(12, 2),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
