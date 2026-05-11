/**
 * Canonical feature-flag registry — the single source of truth for what
 * keys the codebase consumes. Every `requireFlag(...)`, `useFlag(...)`,
 * or worker-side `flagService.isEnabled(...)` call MUST reference a key
 * declared here.
 *
 * Why a code-side const rather than "trust the DB":
 *   - Typo-safety. `isEnabled("comm.bulk_email")` (wrong) silently
 *     evaluates to `false` (unknown → off, per doc 18 §5). The typed
 *     `FeatureFlagKey` union breaks the build instead.
 *   - Lifecycle visibility. Removing a key from this file is the
 *     reviewable signal that a flag is being retired — the matching
 *     DB row is then dropped in a follow-up migration.
 *   - Doc/code parity. `docs/18-feature-flags.md` references this file
 *     so the doc never drifts away from what actually ships.
 *
 * Seed contract: every key here MUST have a matching row in the
 * `feature_flags` table (provisioned by migration `0047_feature_flags`).
 * The startup boot path SHOULD assert this — drift is a deploy bug.
 */

export const FEATURE_FLAG_KEYS = {
  /**
   * Gates the bulk-email feature added in PR #352 (issue #326).
   *
   * Disabled by default until DKIM / SPF / DMARC are configured for
   * the platform's outbound mail domain. Without them every operator-
   * triggered "donor follow-up" looks like phishing to recipient
   * MX servers — discussed with @magino on PR #352. Once the DNS
   * posture is in place this flips to `enabled = true` from the
   * Back Office UI; no deploy required.
   *
   * Surfaces gated by this key:
   *   - API: POST /v1/constituents/bulk-email
   *   - API: GET / POST /v1/constituents/bulk-email-jobs[/:id[/resume]]
   *   - Worker: `communication.bulk_email_requested` outbox events
   *     drop silently when the flag is off (defence in depth — if a
   *     request slipped through the API gate, the worker is the
   *     second wall).
   *   - Web: "Email selection" + "Recent emails" buttons on the
   *     constituents page hide when the flag is off.
   */
  COMMUNICATION_BULK_EMAIL: "communication.bulk_email",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[keyof typeof FEATURE_FLAG_KEYS];

/**
 * Registry entries the seed migration uses to provision the
 * `feature_flags` table. The migration is INSERT … ON CONFLICT DO
 * NOTHING so existing values are preserved across redeploys — the
 * default below is the *first-deploy* value, not a runtime override.
 */
export const FEATURE_FLAG_REGISTRY: ReadonlyArray<{
  key: FeatureFlagKey;
  defaultEnabled: boolean;
  description: string;
}> = [
  {
    key: FEATURE_FLAG_KEYS.COMMUNICATION_BULK_EMAIL,
    defaultEnabled: false,
    description:
      "Operator-triggered bulk email to selected constituents (issue #326). Disabled until the platform's outbound mail domain has DKIM / SPF / DMARC configured — without them every send looks like phishing to recipient MX servers.",
  },
];
