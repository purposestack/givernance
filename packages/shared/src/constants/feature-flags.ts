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
   * the tenant's outbound mail domain. Without them every operator-
   * triggered "donor follow-up" looks like phishing to recipient
   * MX servers — discussed with @magino on PR #352. Once the DNS
   * posture is verified for a tenant, super-admin flips the
   * per-tenant override on from the Back Office; no deploy required.
   *
   * `scope='tenant'` + `tenant_override_allowed=false`
   * (migration 0052, PR #366 follow-up): super-admin gates the
   * deliverability check per tenant — the platform-default stays
   * OFF, super-admin overrides ON for tenants whose DNS posture is
   * verified. Org-admins are NOT self-service yet because
   * DKIM/SPF/DMARC is an operational step they cannot do on their
   * own; once Epic #279 (per-tenant sending domain) ships and
   * tenants can self-verify deliverability, this flag can flip to
   * `tenant_override_allowed=true`.
   *
   * `public=true`: the tenant UI on the constituents page reads
   * `/v1/feature-flags` to hide the bulk-email buttons, so the row
   * must be in the public projection. The projection now correctly
   * overlays the tenant override, so each org sees its own
   * effective value.
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
   * Gates the public donation page style-archetype system (Epic #362).
   *
   * The Epic adds 10 visual archetypes the operator can pick from for
   * the public donation page (`/p/[id]`) — `Foundation`, `Activist`,
   * `Editorial Story`, `Minimal Checkout`, `Emergency Appeal`,
   * `Neo-Brutalist`, `Calm Wellness`, `Civic Modern`, `Retro Print`,
   * `Cosmic Gradient`. With the flag OFF the public page renders
   * today's hardcoded layout — i.e. existing tenants see exactly what
   * they see today, until they explicitly opt in via the picker.
   *
   * `scope='tenant'`: every NPO is independent; one tenant on
   * `cosmic-gradient` shouldn't force every other tenant to be too.
   *
   * `tenant_override_allowed=false` for the initial rollout: super-
   * admin flips the gate per tenant after a brief CSM walk-through.
   * Flips to `true` in a follow-up once the picker UX is proven and
   * org-admins can self-serve safely (no policy reason to keep them
   * out beyond "let's see how the picker lands").
   *
   * `public=true`: SSR-fetch in the settings layout + the campaign
   * editor decides whether to render the "Page style" picker; a
   * private value would unconditionally hide the entry and defeat
   * the Epic.
   *
   * Surfaces gated by this key:
   *   - API: GET / PATCH on `publicPageStyle` field of campaigns and
   *     tenants (Phase 1, PR-2). Routes return 404 not 403 when the
   *     flag is off, so a scanner can't enumerate the feature.
   *   - API: `publicPageStyle` field on `/v1/public/campaigns/:id/page`
   *     response is omitted when the flag is off for the tenant; the
   *     frontend shell falls back to the hardcoded "Foundation-ish"
   *     layout in that case.
   *   - Web: org-level picker on `/settings` (Phase 2, PR-3).
   *   - Web: per-campaign picker on the campaign editor (Phase 2,
   *     PR-3).
   *   - Web: every archetype's lazy-loaded slot bundle is excluded
   *     from the chunk graph when the flag is off — the shell
   *     short-circuits before the dynamic `import()` (ADR-030).
   *
   * Emergency rollback: see `docs/runbooks/feature-flag-rollback.md`
   * if the Back Office is unavailable.
   */
  DONATION_PUBLIC_PAGE_STYLES: "donation.public_page_styles",

  /**
   * Gates the in-app notification centre (Epic #363, GLO-004).
   *
   * The Epic ships the bell icon + side-panel + per-user preferences
   * page + outbox-fanout producer + SSE stream + email-digest worker.
   * With the flag OFF the topbar has no bell at all, the gated routes
   * (`/v1/notifications/*`, `/v1/notification-preferences*`) return
   * 404 not 403, the outbox-fanout worker silently no-ops, and the
   * digest worker skips its tick. End result: a tenant with the flag
   * off is indistinguishable from one before the Epic shipped.
   *
   * `scope='tenant'`: every NPO is independent. A noisy fundraising
   * team that wants notifications shouldn't force a quiet operational
   * team to turn them on too.
   *
   * `tenant_override_allowed=false` for the initial rollout: super-
   * admin keeps the gate per tenant until the UX is verified end-to-
   * end on staging. Flips to `true` in a follow-up once preferences
   * + SSE prove stable (no policy reason to keep org-admins out
   * beyond "let's see how the panel lands first").
   *
   * `public=true`: the appShell layout SSR-fetches `/v1/feature-flags`
   * to decide whether to render the bell icon in the topbar AND
   * whether to mount the polling/SSE client. A private value would
   * unconditionally hide the entry and defeat the Epic.
   *
   * Surfaces gated by this key:
   *   - API: GET / POST / PATCH / DELETE on `/v1/notifications*`
   *   - API: GET / PATCH on `/v1/notification-preferences*`
   *   - API: GET /v1/notifications/stream (SSE)
   *   - Worker: outbox-event fanout into notification rows silently
   *     no-ops (defence in depth — second wall behind the API gate).
   *   - Worker: weekly email-digest BullMQ tick skips if off.
   *   - Web: bell icon + panel + filter chips + `/settings/notifications`
   *     page + sidebar entry + polling/SSE client all hidden.
   *
   * Emergency rollback: see `docs/runbooks/feature-flag-rollback.md`
   * if the Back Office is unavailable.
   */
  COMMUNICATION_NOTIFICATIONS_CENTER: "communication.notifications_center",

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

  /**
   * Gates the bulk-import-constituents feature (Epic #373, PR #385).
   *
   * Off by default until we've watched a few real-world imports go
   * through staging — large CSVs hitting RLS-bound INSERTs is a new
   * shape of write traffic for the platform. `scope='tenant'` +
   * `tenant_override_allowed=true` so each org-admin can self-serve
   * the toggle from /settings/feature-flags once Givernance staff
   * raises the platform default (or while it stays off): there is no
   * platform-level precondition like DKIM — only operational caution.
   *
   * `public=true`: the constituents page reads `/v1/feature-flags`
   * via SSR to decide whether to render the "Bulk import" button.
   *
   * Surfaces gated by this key:
   *   - API: POST /v1/constituents/bulk-import (+ all sub-routes)
   *   - Worker: `constituents.bulk_import_requested` outbox events drop
   *     silently when the flag is off (defence in depth — if a request
   *     slipped through the API gate, the worker is the second wall).
   *   - Web: "Bulk import" button on the constituents page hides when
   *     the flag is off.
   */
  CONSTITUENTS_BULK_IMPORT: "constituents.bulk_import",

  /**
   * Gates the one-click "Replicate" row-action on the Back Office
   * impersonation list (issue #428).
   *
   * The Epic adds a Replicate button next to every past-session row.
   * Click → re-POST `/v1/admin/impersonation` with the original
   * target / mode / reason. If the operator's MFA step-up is still
   * fresh (Keycloak `auth_time` ≤ 5 min, the existing
   * `STEP_UP_AUTH_TIME_WINDOW_SECONDS` window), the new session
   * starts in a single click; otherwise the same stash + bounce-through
   * `/admin/impersonation/new` machinery the start-form already uses
   * picks the request up after the MFA round-trip. With the flag OFF
   * the past-sessions list looks identical to what it shipped — no
   * extra column, no extra DOM, no extra keybinding.
   *
   * `scope='platform'`: this is a dev-/staff-speed feature, not a
   * tenant-facing capability. Only Givernance staff (super-admins)
   * see the button at all; the gate is global, not per-tenant.
   *
   * `tenant_override_allowed=false`: tenants have no business with
   * this flag — it sits behind `super_admin` anyway.
   *
   * `public=true`: the Back Office list page SSR-fetches
   * `/v1/feature-flags` to decide whether to render the Replicate
   * cell. A private projection would unconditionally hide the
   * surface and defeat the Epic.
   *
   * Surfaces gated by this key:
   *   - Web: Replicate column on the past-sessions table at
   *     `/admin/impersonation`.
   *
   * No backend route or schema is gated — Replicate is a pure client
   * wrapper over the existing `POST /v1/admin/impersonation`. The
   * five-step flag pattern still applies (registry + seed migration +
   * parity test + SSR gate + off-state QA) but step 3 (`requireFlag`
   * preHandler) and step 4 (worker `isFlagEnabled`) don't have a
   * surface here.
   *
   * Emergency rollback: see `docs/runbooks/feature-flag-rollback.md`
   * if the Back Office is unavailable.
   */
  ADMIN_IMPERSONATION_REPLICATE: "admin.impersonation_replicate",

  /**
   * Gates the global search / command palette feature (Epic #364, GLO-001).
   *
   * Adds a `Cmd+K` / `Ctrl+K` keyboard binding that opens a `cmdk` overlay
   * with grouped, RLS-scoped cross-entity search across constituents,
   * donations, and campaigns, plus static "go to …" navigation commands and
   * RBAC-aware quick-create actions (new constituent, new donation,
   * new campaign).
   *
   * `scope='tenant'`: every NPO is independent. A tenant on Postgres FTS
   * is the entire feature today, but if Givernance later swaps to an
   * external search engine (Meilisearch / Typesense, hosted EU on
   * Scaleway), the per-tenant gate is the rollout knob — we can pilot
   * the new backend with a single tenant override before flipping the
   * platform default.
   *
   * `tenant_override_allowed=true`: there is no platform-level
   * precondition (no DKIM-style external dependency); each org-admin can
   * self-serve the toggle from `/settings/feature-flags` once we're past
   * the initial rollout.
   *
   * `public=true`: the topbar's `Cmd+K` button + keyboard binding +
   * SSR-rendered overlay shell all need to know the effective value at
   * page-load time. A private projection would unconditionally hide the
   * surface and defeat the Epic.
   *
   * Surfaces gated by this key:
   *   - API: GET /v1/search (`requireFlag` is the FIRST preHandler — a
   *     disabled tenant gets 404, indistinguishable from a typo'd URL,
   *     so a scanner can't enumerate the feature).
   *   - Web: the topbar `Cmd+K` button is completely absent when the
   *     flag is off (no greyed-out placeholder).
   *   - Web: the global `Cmd+K` / `Ctrl+K` keydown listener is NOT
   *     mounted when the flag is off (off-state QA: pressing the
   *     shortcut does nothing).
   *   - Web: the command palette overlay component is not loaded at
   *     all when the flag is off.
   *
   * Public-projection caveat: per the CLAUDE.md feature-flag-first
   * rule, the key name `productivity.command_palette` is intentionally
   * descriptive and not teasing an unannounced surprise, so its
   * presence in `/v1/feature-flags` for every authenticated tenant
   * user is acceptable.
   *
   * Emergency rollback: see `docs/runbooks/feature-flag-rollback.md`.
   */
  PRODUCTIVITY_COMMAND_PALETTE: "productivity.command_palette",

  /**
   * Advanced constituent filtering with complex queries and pattern detection
   * (issue #422). Enables DSL-based filtering with aggregations, patterns
   * (LYBUNT, SYBUNT, recurring, lapsed, major donors), and campaign targeting.
   *
   * `scope='tenant'` + `tenant_override_allowed=true`:
   * Performance-intensive feature that requires DB indexes (migration 0063).
   * Gradual rollout to monitor query performance impact.
   *
   * `public=true`: the tenant UI reads this flag to show/hide advanced
   * filter controls in the constituents module.
   */
  ADVANCED_FILTERS: "advanced_filters",
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
      "Lets operators send one email to several constituents at once from the Constituents page. Off by default — Givernance staff will turn it on for your organisation once your email-deliverability setup is verified so messages don't land in donors' spam folders.",
    scope: "tenant",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.DONATION_PUBLIC_PAGE_STYLES,
    defaultEnabled: false,
    label: "Visual style picker for the public donation page",
    description:
      "Lets your organisation pick from several visual styles for the public donation page that donors see — from a restrained institutional layout to bold activist designs. Off by default: existing campaigns keep their current look until you choose a different style from the Settings menu. Givernance staff turn this on for your organisation after a brief walk-through of the picker.",
    scope: "tenant",
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
  {
    key: FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER,
    defaultEnabled: false,
    label: "In-app notification centre",
    description:
      "Adds a bell icon to the top bar with a panel that lists what happened in your organisation — new donations, postal-export downloads, team invitations, and more. Each member can choose which alerts they want from the Settings menu. Off by default until Givernance staff confirm the bell, panel, and per-member preferences for your organisation.",
    scope: "tenant",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT,
    defaultEnabled: false,
    label: "Bulk import constituents from CSV / Excel",
    description:
      "Lets operators upload a CSV or Excel file (max 10 MB) to create constituents in bulk, with duplicate detection and a per-row progress view. Off by default while we monitor the first real-world imports — flip it on from this page when you're ready.",
    scope: "tenant",
    tenantOverrideAllowed: true,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.ADMIN_IMPERSONATION_REPLICATE,
    defaultEnabled: false,
    label: "One-click Replicate on the Back Office support sessions list",
    description:
      "Adds a Replicate action next to each past support session on the Back Office, so support staff can re-enter the same session in one click without retyping the target and reason. The same security checks still apply on every replicate.",
    scope: "platform",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.PRODUCTIVITY_COMMAND_PALETTE,
    defaultEnabled: false,
    label: "Keyboard quick search (Cmd+K / Ctrl+K)",
    description:
      "Adds a quick search panel that opens with Cmd+K (Mac) or Ctrl+K (Windows / Linux) from any page. Type to find a constituent, donation, or campaign, jump to a section, or start a new record. Off by default while we monitor performance and search quality — flip it on from this page when you're ready.",
    scope: "tenant",
    tenantOverrideAllowed: true,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.ADVANCED_FILTERS,
    defaultEnabled: false,
    label: "Advanced constituent filtering",
    description:
      "Enables powerful filtering capabilities with complex queries, aggregations, and pattern detection (LYBUNT, SYBUNT, recurring donors, lapsed donors, major donors). Performance-intensive feature that requires database indexes. Enable gradually to monitor impact.",
    scope: "tenant",
    tenantOverrideAllowed: true,
    public: true,
  },
];
