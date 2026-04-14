-- Migration: 0017_stripe_connect
-- Adds Stripe Connect support: stripe_account_id on tenants, webhook_events table,
-- unique constraint on donations(org_id, payment_method, payment_ref),
-- partial unique index on tenants.stripe_account_id.

-- ─── Stripe Account on Tenants ─────────────────────────────────────────────

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255);

-- Partial unique index: each Stripe account can belong to at most one tenant
CREATE UNIQUE INDEX IF NOT EXISTS tenants_stripe_account_id_uniq
  ON tenants (stripe_account_id) WHERE stripe_account_id IS NOT NULL;

-- ─── Webhook Event Status Enum ─────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE webhook_event_status AS ENUM ('pending', 'processing', 'completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Webhook Events ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS webhook_events (
  id               UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id  VARCHAR(255)         NOT NULL UNIQUE,
  event_type       VARCHAR(255)         NOT NULL,
  account_id       VARCHAR(255),
  payload          JSONB                NOT NULL,
  status           webhook_event_status NOT NULL DEFAULT 'pending',
  error            TEXT,
  livemode         BOOLEAN              NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  processed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS webhook_events_stripe_event_id_idx ON webhook_events (stripe_event_id);

-- No RLS on webhook_events — events are looked up by stripe_event_id, not org_id.
-- The worker resolves the tenant from the Stripe account ID during processing.

-- ─── Donation idempotency constraint ──────────────────────────────────────

-- Prevents duplicate donations from BullMQ retries processing the same payment
CREATE UNIQUE INDEX IF NOT EXISTS donations_org_payment_uniq
  ON donations (org_id, payment_method, payment_ref)
  WHERE payment_method IS NOT NULL AND payment_ref IS NOT NULL;

-- ─── Grant permissions to app role ──────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON webhook_events TO givernance_app;
