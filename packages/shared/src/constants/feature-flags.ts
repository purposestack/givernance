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
 * `feature_flags` table (provisioned by migration `0047_feature_flags`
 * / `0051_feature_flags_phase2`). The parity integration test asserts
 * label + description + scope + tenant_override_allowed + public
 * parity between this registry and the seeded DB rows; drift fails CI.
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
   * `scope='platform'`: DKIM/SPF/DMARC is a platform precondition,
   * not a per-tenant preference. Stays platform-locked until
   * deliverability is verified end-to-end.
   *
   * `public=true`: the tenant UI on the constituents page reads
   * `/v1/feature-flags` to hide the bulk-email buttons, so the row
   * must be in the public projection.
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

  /**
   * Gates the Feature flags Phase 2 work itself (Epic #365 / PR #366).
   *
   * Even flag-administration tooling gets a flag — the new tenant-
   * override endpoints, the "Feature flags" tab on the tenant detail
   * page, and the org-admin `/settings/feature-flags` page are all
   * net-new user-facing surfaces and deserve the same kill-switch
   * pattern as every other feature.
   *
   * `scope='platform'`: only Givernance staff decide when the
   * Phase 2 surface ships; tenants can't opt themselves in.
   *
   * `public=true`: the org-admin layout reads `/v1/feature-flags`
   * via SSR to decide whether to render the "Feature flags" sidebar
   * entry. A private value here would unconditionally hide the
   * entry, defeating the Epic.
   *
   * The evaluator's precedence change (deprecated → platform-locked
   * → tenant override → default) and the `tenant_flag_overrides`
   * table itself land UN-flagged because they're internal mechanics
   * with no user-observable behaviour change while no overrides
   * exist, and gating the evaluator on a flag is circular.
   *
   * Surfaces gated by this key:
   *   - API: GET/PUT/DELETE /v1/admin/tenants/:id/feature-flags*
   *   - API: GET /v1/org/feature-flags + PATCH /v1/org/feature-flags/:key
   *   - API: `overrideStats` field on GET /v1/admin/feature-flags
   *   - Web: "Feature flags" tab on /admin/tenants/[id]
   *   - Web: /settings/feature-flags page + sidebar entry
   *   - Web: tenant-override count column on /admin/feature-flags
   */
  ADMIN_FEATURE_FLAGS_PHASE2: "admin.feature_flags_phase2",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[keyof typeof FEATURE_FLAG_KEYS];

/**
 * Allowed values for `feature_flags.scope`.
 *
 *   - `platform`: super-admin-controlled only. Tenant overrides are
 *     IGNORED by the evaluator even if rows exist. Use for features
 *     with platform-level preconditions (DKIM posture, internal
 *     tools, billing-integrated capabilities).
 *   - `tenant`: super-admin can set per-tenant overrides; org-admin
 *     can ALSO set them via the self-service page IF
 *     `tenant_override_allowed=true`.
 */
export const FEATURE_FLAG_SCOPES = ["platform", "tenant"] as const;
export type FeatureFlagScope = (typeof FEATURE_FLAG_SCOPES)[number];

/**
 * Registry entries the seed migration uses to provision the
 * `feature_flags` table. The migration is INSERT … ON CONFLICT DO
 * NOTHING so existing values are preserved across redeploys — the
 * defaults below are the *first-deploy* values, not runtime overrides.
 *
 * Text-field convention (PR #352 magino review, reinforced by
 * Epic #365's org-admin audience):
 *   - `label` and `description` are **operator-facing**. Plain
 *     language, no engineering jargon, no issue numbers, no RFC
 *     references. These render in both the super-admin Back Office UI
 *     AND the org-admin `/settings/feature-flags` page (Epic #365).
 *     The latter is read by non-technical NPO org admins — every
 *     string here must pass the "would a fundraising manager
 *     understand this?" check.
 *   - The engineering rationale (DKIM/SPF/DMARC, incident IDs,
 *     follow-up issues) lives in the JSDoc above each `FEATURE_FLAG_KEYS`
 *     entry — invisible to operators, visible to anyone reading the
 *     code.
 */
export const FEATURE_FLAG_REGISTRY: ReadonlyArray<{
  key: FeatureFlagKey;
  defaultEnabled: boolean;
  label: string;
  description: string;
  scope: FeatureFlagScope;
  tenantOverrideAllowed: boolean;
  public: boolean;
}> = [
  {
    key: FEATURE_FLAG_KEYS.COMMUNICATION_BULK_EMAIL,
    defaultEnabled: false,
    label: "Bulk emails to constituents",
    description:
      "Lets operators send one email to several constituents at once from the Constituents page. Currently off — we'll turn it on once the email-deliverability setup is finished so messages don't land in donors' spam folders.",
    scope: "platform",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.ADMIN_FEATURE_FLAGS_PHASE2,
    defaultEnabled: false,
    label: "Per-organisation feature flag controls",
    description:
      "Lets Givernance staff turn features on or off for one organisation at a time, and lets each organisation's admin manage their own feature settings from the Settings menu. Off by default until the new pages have been verified end-to-end.",
    scope: "platform",
    tenantOverrideAllowed: false,
    public: true,
  },
];
