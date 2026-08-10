-- Migration: 0094_seed_bank_mutation_stepup_flag
--
-- Seeds the `security.bank_mutation_stepup` feature flag (manual-test review
-- 2026-07-30, finding #2) — the ENFORCEMENT gate for the bank-mutation step-up
-- guard (`requireBankMutationAcr`, ADR-032 §2.7).
--
-- Posture:
--   * `enabled = FALSE` — default-off. Keycloak does not yet emit a step-up ACR
--     the client can obtain (Appendix B-1), so enforcing it would make every
--     bank-account / settlement mutation a permanent 401. The guard ships
--     unconditionally but only enforces once this flag is flipped on per
--     environment, after the step-up flow exists.
--   * `scope = 'platform'` — platform-wide security posture, not a tenant capability.
--   * `tenant_override_allowed = FALSE`.
--   * `public = FALSE` — server-side enforcement only; no UI reads it.
--
-- Keep label + description + scope + tenant_override_allowed + public in lockstep
-- with FEATURE_FLAG_REGISTRY in `packages/shared/src/constants/feature-flags.ts`.
-- The parity integration test (`feature-flags.test.ts`) fails CI on drift.
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
    'security.bank_mutation_stepup',
    FALSE,
    'Bank-mutation step-up enforcement',
    'Requires a fresh MFA re-authentication before a bank account can be added or edited, or a campaign/fund''s settlement account changed. Off by default until the Keycloak step-up flow is available — while off, these actions do not require re-authentication.',
    'platform',
    FALSE,
    FALSE
  )
ON CONFLICT (key) DO NOTHING;
