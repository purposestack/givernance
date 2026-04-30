-- Migration: 0033_mollie_gateway
-- Sprint 5 / issue #62 — Mollie co-primary gateway + Stripe account.updated lifecycle.
--
-- Adds:
--   * tenants.payment_gateway          — per-tenant gateway selection ('stripe' | 'mollie' | 'manual')
--   * tenants.mollie_api_key           — per-tenant Mollie API key (each NPO brings its own; out-of-scope: KMS-encrypt at rest)
--   * tenants.feature_flags            — JSONB store for `ff.*` overrides (minimal MVP ahead of doc-18 full system)
--   * tenants.stripe_charges_enabled   — cached from `account.updated`; "live mode" = charges_enabled=true
--   * tenants.stripe_payouts_enabled   — cached from `account.updated`
--   * tenants.stripe_details_submitted — cached from `account.updated`
--   * tenants.stripe_account_state_at  — last time the cached fields above were refreshed by a webhook
--
-- Renames:
--   * webhook_events.stripe_event_id → webhook_events.provider_event_id
--   * adds webhook_events.provider with default 'stripe' (backfill existing rows)
--   * unique constraint becomes (provider, provider_event_id) so Stripe + Mollie + future
--     gateways share the table without ID-namespace collisions.
--
-- ADR-010: payment_gateway enum is `stripe | mollie | manual`. Mollie is gated per-tenant by
-- the `ff.payments.mollie` feature flag — the gateway selector enforces this in the API layer.

-- ─── Tenants: payment-gateway selection + Mollie key + flags ───────────────

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS payment_gateway VARCHAR(20) NOT NULL DEFAULT 'stripe';

ALTER TABLE tenants
  ADD CONSTRAINT tenants_payment_gateway_check
  CHECK (payment_gateway IN ('stripe', 'mollie', 'manual'));

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS mollie_api_key VARCHAR(255);

-- Minimal feature-flag store ahead of the full doc-18 system. Holds per-tenant boolean
-- overrides keyed by flag id (e.g. `{"ff.payments.mollie": true}`). Defaults to '{}'::jsonb
-- so the helper can read the column unconditionally without NULL-checks. The full
-- doc-18 plan layers Redis caching + a `tenant_flag_overrides` table on top of this;
-- migrating to that future schema means moving keys out of this column, not changing
-- the helper signature.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS feature_flags JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Cached Stripe Connect state, populated by the `account.updated` webhook handler.
-- Keeping this on the tenant row (rather than a separate `stripe_account_states`
-- table) lets the donor flow read live-mode in a single SELECT and matches the
-- 1:1 cardinality between tenant and connected account. `stripe_account_state_at`
-- is informational — drives the Settings UI's "last refreshed" hint.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_details_submitted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS stripe_account_state_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS tenants_payment_gateway_idx ON tenants (payment_gateway);

-- ─── Webhook events: multi-gateway support ─────────────────────────────────

-- Add `provider` first; backfill existing Stripe rows; then enforce NOT NULL.
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS provider VARCHAR(20);

UPDATE webhook_events SET provider = 'stripe' WHERE provider IS NULL;

ALTER TABLE webhook_events ALTER COLUMN provider SET NOT NULL;
ALTER TABLE webhook_events ALTER COLUMN provider SET DEFAULT 'stripe';
ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_provider_check
  CHECK (provider IN ('stripe', 'mollie'));

-- Rename stripe_event_id → provider_event_id, then re-create the index/uniq. The old
-- index + UNIQUE constraint move with the column under PostgreSQL's `RENAME COLUMN`
-- semantics, but Drizzle Kit names them after the column — we rename them too so
-- pg_dump output matches what `drizzle-kit generate` would emit.
ALTER TABLE webhook_events RENAME COLUMN stripe_event_id TO provider_event_id;

ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS webhook_events_stripe_event_id_key;
DROP INDEX IF EXISTS webhook_events_stripe_event_id_idx;

-- Composite uniqueness so Mollie payment ids can repeat Stripe event ids without conflict.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_provider_event_uniq
  ON webhook_events (provider, provider_event_id);

CREATE INDEX IF NOT EXISTS webhook_events_provider_event_id_idx
  ON webhook_events (provider_event_id);

-- ─── Permissions for the app role ──────────────────────────────────────────

-- Grants on tenants are inherited from the existing role bootstrap; new columns
-- are visible automatically. webhook_events grants from migration 0017 cover the
-- renamed column without an explicit re-grant.
