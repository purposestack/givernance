-- Migration: 0093_seed_receipt_envelope_encryption_flag
--
-- Seeds the `donation.receipt_envelope_encryption` feature flag
-- (envelope encryption of tax-receipt PDFs — issue #228).
--
-- Posture:
--   * `enabled = FALSE` — default-off (feature-flag-first rule). With
--     the flag off, receipt generation is byte-for-byte identical to
--     today (plaintext PDF + SSE-S3).
--   * `scope = 'platform'` — infrastructure posture, staff-controlled:
--     enabling requires the RECEIPT_ENCRYPTION_* KEK env vars to be
--     deployed first, otherwise generation jobs fail (fail-closed —
--     never a silent plaintext fallback).
--   * `tenant_override_allowed = FALSE` — platform scope; overrides
--     are ignored by the evaluator anyway.
--   * `public = FALSE` — no tenant-visible surface changes; the
--     download path decrypts transparently regardless of the flag.
--
-- Keep label + description + scope + tenant_override_allowed + public
-- in lockstep with FEATURE_FLAG_REGISTRY in
-- `packages/shared/src/constants/feature-flags.ts`. The parity
-- integration test (`feature-flags.test.ts`) fails CI on drift.
--
-- Idempotent — `ON CONFLICT (key) DO NOTHING`.

INSERT INTO feature_flags (
  key,
  enabled,
  label,
  description,
  scope,
  tenant_override_allowed,
  public
)
VALUES
  (
    'donation.receipt_envelope_encryption',
    FALSE,
    'Receipt envelope encryption',
    'Strengthens how donation tax receipts are stored: each newly generated receipt PDF is sealed with its own encryption key, and those keys can be rotated centrally without touching the stored files. Managed by Givernance staff — turning it on requires encryption keys to be configured on the platform first. Existing receipts keep working unchanged.',
    'platform',
    FALSE,
    FALSE
  )
ON CONFLICT (key) DO NOTHING;
