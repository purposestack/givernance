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

  /**
   * Gates the merged single multi-page PDF option for postal exports
   * (project item #194221573 — "Export PDF unique multi-pages").
   *
   * The postal export (Epic #274) always shipped a ZIP of one PDF per
   * recipient. This adds a second output format — a single concatenated
   * PDF (1 page/constituent in standard mode, 2/3 in the Swiss QR-bill
   * modes) so an operator can hand the whole batch to a printer without
   * unzipping. The export endpoint itself is un-flagged (pre-dates the
   * flag system), so this gate lives INSIDE the existing route rather
   * than as a `requireFlag` 404 preHandler: with the flag off the
   * `format=merged_pdf` request body is rejected (`merged_pdf_disabled`)
   * and the web panel hides the format selector entirely — the export
   * is always a ZIP, exactly as before the option existed.
   *
   * Engineering rationale (NOT operator-facing): a merged PDF is built
   * fully in memory (pdf-lib has no page-by-page streaming), unlike the
   * RAM-bounded streamed ZIP. The API therefore caps the recipient count
   * for `merged_pdf` (`MERGED_PDF_MAX_RECIPIENTS`) and falls back to the
   * ZIP suggestion above it. Default-off so the cap + memory profile can
   * be validated on staging before a platform-wide enable.
   *
   * `scope='tenant'`, `tenant_override_allowed=false`: super-admin keeps
   * the gate per tenant during the initial rollout.
   *
   * `public=true`: the campaign page SSR-fetches `/v1/feature-flags` to
   * decide whether to render the format selector in the postal panel.
   *
   * Surfaces gated by this key:
   *   - API: `format=merged_pdf` on POST /v1/campaigns/:id/postal-exports
   *     (in-handler gate; off ⇒ `merged_pdf_disabled`).
   *   - Worker: `postal-export` processor re-checks at pickup (defence in
   *     depth) and fails the job if a merged_pdf row slipped through.
   *   - Web: the ZIP/merged-PDF format selector in the postal export panel.
   *
   * Emergency rollback: see `docs/runbooks/feature-flag-rollback.md`.
   */
  CAMPAIGN_POSTAL_MERGED_PDF: "campaign.postal_merged_pdf",

  /**
   * Gates multi-valued constituent type (issue #465).
   *
   * A constituent's `type` was historically a single picklist value
   * (`donor` | `volunteer` | `member` | `beneficiary` | `partner`). Real
   * NPOs need overlap — a donor who also volunteers, a beneficiary who
   * becomes a member. The storage moved to a `types text[]` array
   * (additive migration `0083_constituent_types_array`); the legacy
   * singular `type` column is kept in lockstep as `types[0]` for one
   * release so an un-migrated reader never 500s during rollout.
   *
   * `scope='tenant'` + `tenant_override_allowed=true`: there is no
   * platform-level precondition (no DKIM-style infra gate) — only the
   * usual caution of letting a tenant opt into a new data-entry shape.
   * Org-admins can self-serve the toggle from /settings/feature-flags.
   *
   * `public=true`: the constituents page SSR-fetches `/v1/feature-flags`
   * to decide whether to render the multiselect control (vs the legacy
   * single Select) and the multi-badge display.
   *
   * Off-state contract (the array is ALWAYS the storage, the flag only
   * gates the new affordances):
   *   - API: `POST` / `PUT /v1/constituents` reject a `types` payload
   *     with more than one element (`multi_type_disabled`) so the
   *     effective behaviour is identical to the single-picklist era.
   *     Single-element arrays + the legacy `type` field always work.
   *   - Web: the create/edit form renders the legacy single Select; the
   *     list quick-filter and advanced-filter control stay single-value;
   *     every badge spot shows one badge (the first type).
   */
  CONSTITUENTS_MULTI_TYPE: "constituents.multi_type",

  /**
   * Gates custom fields on the constituent domain (Epic #539, PR-1..6).
   *
   * One flag per domain — deliberate per-domain kill switches so a
   * problem confined to one surface (e.g. a slow projected column on
   * the donation list) can be disabled without pulling the whole
   * customization engine platform-wide. The definitions registry,
   * `custom` JSONB columns, and erasure hooks are always live
   * (erasure is NEVER flag-gated); the flags gate the operator/admin
   * affordances only.
   *
   * `scope='tenant'` + `tenant_override_allowed=false` for the initial
   * rollout (bulk-email precedent): Givernance staff enable per tenant
   * after a brief CSM walk-through of the field builder + quota meter.
   * Graduation to org-admin self-service is Epic #539 open question #6.
   *
   * `public=true`: `/settings/custom-fields` (tab visibility), the
   * constituent form/detail/list, the filter builder, and the export
   * button all SSR-fetch `/v1/feature-flags` to hide their surfaces.
   *
   * Surfaces gated by this key:
   *   - API: `/v1/custom-fields*` routes for `domain='constituent'`
   *     (the catalog route filters domains to enabled flags).
   *   - API: `custom` payload on constituent create/update; `?filters=`
   *     conditions on `custom.<key>` fields; CSV export custom columns.
   *   - Worker: bulk-import template 1.1 custom columns + row
   *     validation re-check `isFlagEnabled` at pickup.
   *   - Web: constituents tab of /settings/custom-fields, form section,
   *     detail rows, list columns, filter category.
   *
   * Emergency rollback: see `docs/runbooks/feature-flag-rollback.md`.
   */
  CONSTITUENTS_CUSTOM_FIELDS: "constituents.custom_fields",

  /**
   * Gates custom fields on the donation domain (Epic #539). See
   * `CONSTITUENTS_CUSTOM_FIELDS` for the per-domain kill-switch
   * rationale and rollout posture (same: tenant scope, staff-enabled,
   * public projection).
   *
   * Surfaces gated by this key:
   *   - API: `/v1/custom-fields*` routes for `domain='donation'`;
   *     `custom` payload on donation create/update.
   *   - Web: donations tab of /settings/custom-fields, form section,
   *     detail rows, list columns.
   *
   * NOT gated by this key: the `donorCustom` projection on donation
   * list/detail. It rides the CONSTITUENT defs (`show_on_related`) and
   * renders on donation surfaces, but it is gated by
   * `CONSTITUENTS_CUSTOM_FIELDS` (epic #539 §6 — projection follows the
   * source domain's flag, so turning donation-own fields off never hides
   * the donor's opted-in fields). Off-state QA of THIS flag must expect
   * `donorCustom` to remain when the constituent flag is still on.
   */
  DONATIONS_CUSTOM_FIELDS: "donations.custom_fields",

  /**
   * Gates advanced filtering on the donations list (follow-up to Epic
   * #418 / ADR-033, which shipped the constituent engine under the
   * legacy-flat `advanced_filters` key — this one follows the dotted
   * `<domain>.<feature>` convention).
   *
   * The donation engine reuses the constituents DSL + validation +
   * operator machinery but ships its own donation-grain field catalog
   * (amounts, dates, status/payment enums, campaign/fund attribution,
   * receipt state, donor name via the existing list join). No
   * aggregates, no LYBUNT-style patterns — donations are the row grain.
   * Filtering donations by DONOR custom fields is explicitly vetoed
   * (Epic #539 §6); donation-own custom fields in this engine are a
   * fast-follow once the registry merge is parameterised by domain.
   *
   * `scope='tenant'` + `tenant_override_allowed=false` for the initial
   * rollout: staff-enabled per tenant while query-performance impact is
   * monitored (same posture as the constituents engine's early rollout;
   * graduation to org-admin self-service once proven).
   *
   * `public=true`: the donations page SSR-fetches `/v1/feature-flags`
   * to decide whether to render the filter-builder entry point.
   *
   * Surfaces gated by this key:
   *   - API: the `?filters=` DSL param on GET /v1/donations (param
   *     present + flag off → 404, `requireFlag` posture — never a
   *     silently-unfiltered result).
   *   - API: GET /v1/donations/filter/fields, POST
   *     /v1/donations/filter/preview, GET /v1/donations/filter/
   *     suggestions (requireFlag FIRST preHandler, 404 when off).
   *   - Web: the FilterBuilder button + chips on the donations page.
   *
   * Emergency rollback: see `docs/runbooks/feature-flag-rollback.md`.
   */
  DONATIONS_ADVANCED_FILTERS: "donations.advanced_filters",

  /**
   * Gates envelope encryption of tax-receipt PDFs (issue #228).
   *
   * Receipts are legal fiscal documents (CERFA) with a 7-year retention
   * horizon — long enough that "the bucket got exposed once" must not
   * mean "seven years of donor tax documents leaked". With the flag ON,
   * the worker seals each NEWLY generated receipt PDF with its own
   * fresh AES-256-GCM data key (DEK); the S3 object is pure ciphertext
   * (IV + auth tag live on the `receipts` row) and the DEK is wrapped
   * by a key-encryption key (KEK) held OUTSIDE the object store —
   * Scaleway Key Manager in SaaS prod, a local keyring
   * (`RECEIPT_ENCRYPTION_LOCAL_KEYRING`) on dev / staging /
   * self-hosted. KEK rotation re-wraps DEKs in the DB only (the
   * `receipts.rewrap_deks` sweep) — zero S3 rewrites.
   *
   * `scope='platform'`: this is an infrastructure posture, not a
   * per-NPO preference — flipping it requires the KEK env vars to be
   * deployed, so only Givernance staff control it. Enabling without
   * `RECEIPT_ENCRYPTION_*` configured makes generation jobs FAIL
   * (fail-closed by design — never a silent plaintext fallback).
   *
   * `public=false`: no tenant-visible surface changes; donors and
   * operators download receipts exactly as before.
   *
   * Gate placement:
   *   - Worker: `generate-receipt` checks at pickup — ON encrypts, OFF
   *     keeps today's plaintext+SSE-S3 upload byte-for-byte.
   *   - Worker: `receipts.rewrap_deks` (manual rotation sweep) no-ops
   *     when OFF.
   *   - API: the download route is NOT flag-gated — it decrypts any
   *     row whose `encryption_scheme` says it is encrypted, so
   *     flipping the flag OFF never bricks already-encrypted receipts.
   *
   * Emergency rollback: see `docs/runbooks/feature-flag-rollback.md`.
   * Turning the flag off stops encrypting NEW receipts only.
   */
  DONATION_RECEIPT_ENVELOPE_ENCRYPTION: "donation.receipt_envelope_encryption",

  /**
   * Gates custom fields on the campaign domain (Epic #539). See
   * `CONSTITUENTS_CUSTOM_FIELDS` for the per-domain kill-switch
   * rationale and rollout posture (same: tenant scope, staff-enabled,
   * public projection).
   *
   * Surfaces gated by this key:
   *   - API: `/v1/custom-fields*` routes for `domain='campaign'`;
   *     `custom` payload on campaign create/update.
   *   - Web: campaigns tab of /settings/custom-fields, form section,
   *     detail rows, list columns.
   */
  CAMPAIGNS_CUSTOM_FIELDS: "campaigns.custom_fields",

  /**
   * Gates the nightly branding orphan-GC sweep worker job (issue #291,
   * ADR-023 § Consequences, ADR-024 "drift to nightly orphan-GC").
   *
   * The sweep DELETES objects from the public-read branding bucket and
   * hard-deletes `org_branding_assets` rows past their 7-day grace, so
   * a net-new destructive cron gets a platform-wide kill-switch: the
   * flag is checked at job pickup in
   * `packages/worker/src/processors/branding-orphan-gc-sweep.ts`, and
   * an off flag makes the nightly tick a logged no-op. There is no API
   * or web surface — worker-only.
   *
   * `scope='platform'` (first platform-scope flag): enabling is a
   * Givernance-staff decision taken once per environment after the
   * staging soak documented in
   * `docs/runbooks/branding-bucket-prod-bringup.md`; tenant overrides
   * are meaningless for a platform-wide sweep and are ignored by the
   * evaluator at this scope.
   *
   * `public=false`: internal ops flag; nothing donor- or
   * operator-facing reads it.
   *
   * Emergency rollback: flip the flag off (Back Office or
   * `docs/runbooks/feature-flag-rollback.md`) — the next nightly tick
   * no-ops. Already-deleted orphans are NOT recoverable (they were
   * 7+ days past soft-delete/replacement by definition).
   */
  BRANDING_ORPHAN_GC_SWEEP: "branding.orphan_gc_sweep",

  /**
   * Gates multi-fund routing within a campaign (ADR-031 §2.5, Epic #416).
   *
   * Task 4 (this task) ships the schema expansion and CRUD API behind this
   * flag. Task 8 will add the full registry entry (label + description +
   * seed migration) and flip the flag default to false/platform-gated once
   * the end-to-end split-payment flow is proven on staging.
   *
   * Surfaces gated by this key (Task 4):
   *   - API: GET /v1/campaigns/:id/funds (new routing-aware endpoint)
   *   - API: POST /v1/campaigns/:id/funds
   *   - API: PATCH /v1/campaigns/:id/funds/:fundId
   *   - API: DELETE /v1/campaigns/:id/funds/:fundId
   */
  DONATION_FUND_ROUTING: "donation.fund_routing",
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
    key: FEATURE_FLAG_KEYS.ADVANCED_FILTERS,
    defaultEnabled: false,
    label: "Advanced constituent filtering",
    description:
      "Enables powerful filtering capabilities with complex queries, aggregations, and pattern detection (LYBUNT, SYBUNT, recurring donors, lapsed donors, major donors). Performance-intensive feature that requires database indexes. Enable gradually to monitor impact.",
    scope: "tenant",
    tenantOverrideAllowed: true,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.CAMPAIGN_POSTAL_MERGED_PDF,
    defaultEnabled: false,
    label: "Single merged PDF for postal mailings",
    description:
      "Adds an option to download a postal mailing as one combined PDF (one page per recipient) instead of a ZIP of separate files — handy for sending the whole batch straight to a printer. Off by default: exports stay as a ZIP until Givernance staff turn this on for your organisation. Very large mailings always use the ZIP.",
    scope: "tenant",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE,
    defaultEnabled: false,
    label: "Multiple types per constituent",
    description:
      "Lets a single constituent hold several types at once — for example someone who is both a donor and a volunteer — instead of just one. Off by default: each constituent keeps a single type until you turn this on from this page.",
    scope: "tenant",
    tenantOverrideAllowed: true,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS,
    defaultEnabled: false,
    label: "Custom fields on constituents",
    description:
      "Lets your organisation define its own typed fields on constituent records — text, numbers, dates, checkboxes, amounts, and picklists with managed options — then fill, filter, and export them like any built-in field. Off by default: Givernance staff turn it on for your organisation during the initial rollout.",
    scope: "tenant",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS,
    defaultEnabled: false,
    label: "Custom fields on donations",
    description:
      "Lets your organisation define its own typed fields on donation records — for example an internal reference or a thematic classification — then fill and export them like any built-in field. Off by default: Givernance staff turn it on for your organisation during the initial rollout.",
    scope: "tenant",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.DONATIONS_ADVANCED_FILTERS,
    defaultEnabled: false,
    label: "Advanced donation filtering",
    description:
      "Enables powerful filtering on the donations list — combine conditions on amounts, dates, payment details, campaigns, funds, receipt status, and donor names, with shareable filter links. Off by default: Givernance staff turn it on for your organisation while query performance is monitored.",
    scope: "tenant",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.DONATION_RECEIPT_ENVELOPE_ENCRYPTION,
    defaultEnabled: false,
    label: "Receipt envelope encryption",
    description:
      "Strengthens how donation tax receipts are stored: each newly generated receipt PDF is sealed with its own encryption key, and those keys can be rotated centrally without touching the stored files. Managed by Givernance staff — turning it on requires encryption keys to be configured on the platform first. Existing receipts keep working unchanged.",
    scope: "platform",
    tenantOverrideAllowed: false,
    public: false,
  },
  {
    key: FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS,
    defaultEnabled: false,
    label: "Custom fields on campaigns",
    description:
      "Lets your organisation define its own typed fields on campaign records — for example a budget code or an audience segment — then fill and export them like any built-in field. Off by default: Givernance staff turn it on for your organisation during the initial rollout.",
    scope: "tenant",
    tenantOverrideAllowed: false,
    public: true,
  },
  {
    key: FEATURE_FLAG_KEYS.BRANDING_ORPHAN_GC_SWEEP,
    defaultEnabled: false,
    label: "Nightly logo storage cleanup",
    description:
      "Runs a nightly maintenance job that permanently removes logo files left behind after a logo was replaced or deleted, once a 7-day safety window has passed. Off by default: Givernance staff enable it per environment after verification.",
    scope: "platform",
    tenantOverrideAllowed: false,
    public: false,
  },
];
