-- Migration: 0070_payment_attempts (Epic #434, issue #435)
--
-- New table feeding the "Taux d'échec paiement" KPI on the super-admin
-- dashboard + the per-tenant payment-failure heat strip. One row per
-- Stripe PaymentIntent we observe — both successful and failed
-- attempts — so the KPI denominator (total attempts in period) and
-- numerator (failed attempts in period) are queryable from a single
-- table without joining the donations table for negative space.
--
-- Why a separate table, not just a column on `donations`:
--   * Failed payment intents never produce a `donations` row today
--     (the donation insert is gated on a successful charge); we have
--     no historical trail of "how often did Stripe say no" at all.
--   * `requires_action` (3DS, SCA challenge) is a third lifecycle
--     state distinct from succeeded/failed — it's a UX-friction signal
--     worth its own column for future "donor drop-off after 3DS" KPIs.
--
-- Populated by the `payment_intent.payment_failed` +
-- `payment_intent.succeeded` + `payment_intent.requires_action`
-- webhook handlers wired up in SUB-WORKER #436. `stripe_payment_intent_id`
-- is UNIQUE — Stripe redeliveries upsert into the same row by
-- `ON CONFLICT (stripe_payment_intent_id) DO UPDATE`.
--
-- RLS enabled + FORCED with per-tenant policy. Per the CLAUDE.md
-- "RLS is the safety net, never the contract" rule, the API code MUST
-- still carry `eq(paymentAttempts.orgId, ctx.orgId)` explicitly on
-- every read/write — RLS is defence-in-depth, not the gate.
--
-- Indexes:
--   * `(org_id, created_at)` — supports the per-tenant + period-scoped
--     count query that powers the dashboard tile.
--   * `(status, created_at) WHERE status='failed'` — partial index so
--     the platform-wide "all failures in last 30d" sweep doesn't scan
--     successful rows (which are 95%+ of the table by volume on a
--     healthy day).

-- ─── Enum ────────────────────────────────────────────────────────────

CREATE TYPE payment_attempt_status AS ENUM (
  'succeeded',
  'failed',
  'requires_action'
);

-- ─── Table ───────────────────────────────────────────────────────────

CREATE TABLE payment_attempts (
  id                        UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    UUID                   NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_payment_intent_id  TEXT                   NOT NULL UNIQUE,
  currency                  VARCHAR(3)             NOT NULL,
  amount_cents              INTEGER                NOT NULL,
  status                    payment_attempt_status NOT NULL,
  -- Stripe's `last_payment_error.code` (e.g. `card_declined`).
  failure_code              TEXT,
  -- Stripe's `last_payment_error.message`. PII-free per Stripe contract
  -- but the API tenant-projection MUST scrub before exposing to non-
  -- super-admin callers (security-architect re-review item).
  failure_message           TEXT,
  -- Stripe's `charges.data[0].outcome.reason` (`risk_threshold`,
  -- `highest_risk_level`, …) — surfaces Radar-level signals separate
  -- from the bank-side `failure_code`.
  outcome_reason            TEXT,
  created_at                TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ            NOT NULL DEFAULT NOW()
);

CREATE INDEX payment_attempts_org_created_idx
  ON payment_attempts (org_id, created_at);

CREATE INDEX payment_attempts_failed_created_idx
  ON payment_attempts (status, created_at)
  WHERE status = 'failed';

ALTER TABLE payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON payment_attempts
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON payment_attempts TO givernance_app;
