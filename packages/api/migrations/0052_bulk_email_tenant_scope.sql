-- Migration: 0052_bulk_email_tenant_scope (Epic #365 / PR #366 follow-up)
--
-- Relaxes `communication.bulk_email` from `scope='platform'` (where
-- it landed in migration 0051) to `scope='tenant'` with
-- `tenant_override_allowed=false`. Super-admin still owns the gate
-- — Givernance staff flip it on per tenant once they've verified
-- the tenant's mail-deliverability posture — but the kill-switch is
-- now per-tenant rather than all-or-nothing.
--
-- Why the change: the prior posture forced "every tenant on or
-- every tenant off." A super-admin who has verified DKIM/SPF/DMARC
-- for tenant A but not yet for tenant B could not turn the feature
-- on for A without exposing B's donors to "looks like phishing"
-- emails. The Phase-2 tenant-overrides surface (PR #366) makes
-- per-tenant gating practical, so this migration aligns the flag's
-- scope with how it's actually intended to be operated.
--
-- `tenant_override_allowed` stays `FALSE`: org-admins are NOT
-- self-service for this flag yet. The DKIM verification is an
-- operational step a tenant cannot do for themselves, so the
-- super-admin retains the master key until Epic #279 (per-tenant
-- sending domain) ships and tenants can self-verify deliverability.
--
-- `public` stays `TRUE` — the constituents page still reads
-- `/v1/feature-flags` to hide the bulk-email buttons when the
-- effective value for the caller's org is `false`. The public
-- projection now correctly overlays the tenant override.
--
-- Idempotent: re-applying the UPDATE on a row that already has
-- `scope='tenant'` is a no-op (just bumps `updated_at`).

UPDATE feature_flags
SET
  scope = 'tenant',
  tenant_override_allowed = FALSE,
  -- Description rewrite — the operator-facing copy now reflects that
  -- the flag is per-organisation (Givernance staff turn it on per
  -- tenant once that tenant's deliverability posture is verified)
  -- rather than the prior platform-wide phrasing. Kept in lockstep
  -- with `FEATURE_FLAG_REGISTRY` in
  -- `packages/shared/src/constants/feature-flags.ts` (parity test
  -- in `feature-flags.test.ts` catches drift).
  description = 'Lets operators send one email to several constituents at once from the Constituents page. Off by default — Givernance staff will turn it on for your organisation once your email-deliverability setup is verified so messages don''t land in donors'' spam folders.',
  updated_at = NOW()
WHERE key = 'communication.bulk_email';
