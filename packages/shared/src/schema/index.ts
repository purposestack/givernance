/**
 * Drizzle ORM schema definitions.
 * All tables include org_id for row-level security and audit columns.
 */

import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { Locale } from "../i18n/locales.js";

// ─── Receipt Enums ──────────────────────────────────────────────────────────

export const receiptStatusEnum = pgEnum("receipt_status", ["pending", "generated", "failed"]);

// ─── Campaign Enums ─────────────────────────────────────────────────────────

/** Canonical campaign type values — used in DB enum, TypeBox schemas, and service types */
export const CAMPAIGN_TYPE_VALUES = ["nominative_postal", "door_drop", "digital"] as const;
export type CampaignType = (typeof CAMPAIGN_TYPE_VALUES)[number];

export const campaignTypeEnum = pgEnum("campaign_type", [...CAMPAIGN_TYPE_VALUES]);

export const CAMPAIGN_STATUS_VALUES = ["draft", "active", "closed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUS_VALUES)[number];

export const campaignStatusEnum = pgEnum("campaign_status", [...CAMPAIGN_STATUS_VALUES]);

/**
 * Public donation page visual archetypes (Epic #362, migration 0054).
 *
 * Re-exported from the operator-facing source of truth in
 * `@givernance/shared/constants` (`PUBLIC_PAGE_STYLE_KEYS`). Keep the
 * two in lockstep — adding an archetype is a one-place change in the
 * constants file; this schema and the migration mirror it. The
 * integration parity test in
 * `packages/api/src/tests/integration/public-page-styles.test.ts`
 * fails CI on drift.
 */
import { PUBLIC_PAGE_STYLE_KEYS } from "../constants/public-page-styles";
export const publicPageStyleEnum = pgEnum("public_page_style", [...PUBLIC_PAGE_STYLE_KEYS]);

export const campaignDocumentStatusEnum = pgEnum("campaign_document_status", [
  "pending",
  "generated",
  "failed",
]);

/** Postal export modes — `door_drop` (single generic letter), `personalized` (one per linked constituent). */
export const POSTAL_EXPORT_MODE_VALUES = ["door_drop", "personalized"] as const;
export type PostalExportMode = (typeof POSTAL_EXPORT_MODE_VALUES)[number];

export const postalExportModeEnum = pgEnum("postal_export_mode", [...POSTAL_EXPORT_MODE_VALUES]);

/** Postal export job lifecycle. `pending` → `processing` → `completed | failed`. */
export const POSTAL_EXPORT_STATUS_VALUES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export type PostalExportStatus = (typeof POSTAL_EXPORT_STATUS_VALUES)[number];

export const postalExportStatusEnum = pgEnum("postal_export_status", [
  ...POSTAL_EXPORT_STATUS_VALUES,
]);

// ─── Donation-related Enums ──────────────────────────────────────────────────

export const FUND_TYPE_VALUES = ["restricted", "unrestricted"] as const;
export type FundType = (typeof FUND_TYPE_VALUES)[number];

export const fundTypeEnum = pgEnum("fund_type", [...FUND_TYPE_VALUES]);

export const donationStatusEnum = pgEnum("donation_status", [
  "pending",
  "cleared",
  "refunded",
  "failed",
]);

export const pledgeFrequencyEnum = pgEnum("pledge_frequency", ["monthly", "yearly"]);

export const pledgeStatusEnum = pgEnum("pledge_status", ["active", "paused", "cancelled"]);

export const installmentStatusEnum = pgEnum("installment_status", ["pending", "paid", "failed"]);

// ─── Webhook Enums ─────────────────────────────────────────────────────────

export const webhookEventStatusEnum = pgEnum("webhook_event_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

// ─── Enums ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["org_admin", "user", "viewer"]);

// ─── Tenant lifecycle / provenance (ADR-016) ─────────────────────────────────

export const TENANT_STATUS_VALUES = ["provisional", "active", "suspended", "archived"] as const;
export type TenantStatus = (typeof TENANT_STATUS_VALUES)[number];

export const TENANT_CREATED_VIA_VALUES = ["self_serve", "enterprise", "invitation"] as const;
export type TenantCreatedVia = (typeof TENANT_CREATED_VIA_VALUES)[number];

export const TENANT_DISPUTE_STATE_VALUES = [
  "open",
  "resolved_kept",
  "resolved_transferred",
  "rejected",
] as const;
export type TenantDisputeState = (typeof TENANT_DISPUTE_STATE_VALUES)[number];

export const TENANT_DOMAIN_STATE_VALUES = ["pending_dns", "verified", "revoked"] as const;
export type TenantDomainState = (typeof TENANT_DOMAIN_STATE_VALUES)[number];

export const TENANT_ADMIN_DISPUTE_RESOLUTION_VALUES = [
  "kept",
  "replaced",
  "escalated_to_support",
] as const;
export type TenantAdminDisputeResolution = (typeof TENANT_ADMIN_DISPUTE_RESOLUTION_VALUES)[number];

// ─── Tenants (organizations) ──────────────────────────────────────────────────

/** Tenants — registered organizations using Givernance */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    /**
     * Mission statement of the organisation (Epic #274 follow-up).
     * Used as flavour text on generated postal letters and as a reusable
     * description elsewhere in the app (public donation page footer, AI
     * assistant context). Free-form, hard-capped at 1000 chars by a DB
     * CHECK constraint (see migration 0040) so a future code path that
     * bypasses the validator can't blow past the letterhead band; the
     * validator mirrors that cap for early UX feedback. NULL until the
     * operator fills the org-settings form.
     */
    mission: text("mission"),
    plan: varchar("plan", { length: 50 }).notNull().default("starter"),
    status: varchar("status", { length: 50 }).notNull().default("active").$type<TenantStatus>(),
    /** How this tenant was provisioned — drives UI affordances, not access. Migration 0021 (ADR-016). */
    createdVia: varchar("created_via", { length: 32 })
      .notNull()
      .default("enterprise")
      .$type<TenantCreatedVia>(),
    /** Email verification timestamp for self-serve signup; NULL until the first admin verifies. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /**
     * Back-office ownership confirmation timestamp for self-serve tenants.
     * This is distinct from `verifiedAt`: the user keeps access after signup
     * verification, while super-admins confirm the workspace's ownership later.
     */
    ownershipConfirmedAt: timestamp("ownership_confirmed_at", { withTimezone: true }),
    /** Keycloak 26 Organization id (UUID) bound to this tenant; enforced by CHECK in migration 0021. */
    keycloakOrgId: varchar("keycloak_org_id", { length: 64 }),
    /** Convenience pointer to the tenant's verified primary domain — denormalised; source of truth is `tenant_domains`. */
    primaryDomain: varchar("primary_domain", { length: 255 }),
    baseCurrency: varchar("base_currency", { length: 3 }).notNull().default("EUR"),
    /**
     * ISO-3166-1 alpha-2 (FR, BE, DE, …) — captured at signup. Drives
     * legal/jurisdiction logic (currency hint, fiscal receipts, future
     * GDPR data-residency reads). NOT used for email-language selection;
     * that's `default_locale`. Issue #153.
     */
    country: varchar("country", { length: 2 }),
    /**
     * BCP-47 default locale for this tenant — every member with
     * `users.locale = NULL` follows this value. The 2nd layer in the
     * 3-layer chain (`user.locale ?? tenant.default_locale ??
     * APP_DEFAULT_LOCALE`). NOT NULL with a `'fr'` floor (ADR-015 +
     * issue #153 amendment). The migration's CHECK constraint enforces
     * the supported set; keep this in lockstep with `SUPPORTED_LOCALES`
     * in `@givernance/shared/i18n`.
     */
    defaultLocale: varchar("default_locale", { length: 10 })
      .notNull()
      .default("fr")
      .$type<Locale>(),
    stripeAccountId: varchar("stripe_account_id", { length: 255 }),
    /**
     * Active branding logo (Epic #286). FK to `org_branding_assets.id`
     * with `ON DELETE SET NULL` so a hard-deleted asset row leaves the
     * tenant pointer dangling-clear, never broken. The pointer is set
     * by the `branding.activate_logo` worker job after the pipeline
     * flips the asset to `status='ready'`. NULL = no logo configured;
     * UI surfaces fall back to the Givernance default + org name.
     */
    logoAssetId: uuid("logo_asset_id"),
    /**
     * Default public donation page archetype for this org (Epic #362).
     * NULL = "inherit the hardcoded platform default (`foundation`)".
     * `org_admin` writes this from /settings; the campaign editor
     * inherits from it on first publish unless the campaign owner
     * explicitly overrides via `campaigns.public_page_style`. The
     * three-layer resolution at read time is:
     *
     *   campaigns.public_page_style       (per-campaign override)
     *   ?? tenants.default_public_page_style (org-level default)
     *   ?? "foundation"                     (platform default)
     *
     * The donor-facing API only returns a non-null value when the
     * `donation.public_page_styles` flag is on for this tenant; with
     * the flag off, the shell falls back to today's hardcoded layout
     * regardless of what's stored here.
     */
    defaultPublicPageStyle: publicPageStyleEnum("default_public_page_style"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("tenants_stripe_account_id_uniq").on(table.stripeAccountId),
    index("tenants_status_idx").on(table.status),
    index("tenants_created_via_idx").on(table.createdVia),
  ],
);

// ─── Users ────────────────────────────────────────────────────────────────────

/** Users — staff members within a tenant organization */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }).notNull(),
    role: userRoleEnum("role").notNull().default("user"),
    keycloakId: varchar("keycloak_id", { length: 255 }),
    /** Marks the user who provisioned a self-serve tenant. Drives the dispute flow (ADR-016). */
    firstAdmin: boolean("first_admin").notNull().default(false),
    /** When set, this user is a *provisional* org_admin until this timestamp; other members can dispute. */
    provisionalUntil: timestamp("provisional_until", { withTimezone: true }),
    /** Last time this user picked this tenant in the org switcher — drives the picker default (ADR-016 / doc 22 §6.3). */
    lastVisitedAt: timestamp("last_visited_at", { withTimezone: true }),
    /**
     * BCP-47 personal locale override — the 1st layer in the 3-layer
     * chain. NULL means "follow my tenant's default" so subsequent
     * tenant-default changes apply automatically. The invitation-accept
     * service sets this only when the invitee explicitly picks a value
     * different from the tenant default at acceptance time (issue #153).
     */
    locale: varchar("locale", { length: 10 }).$type<Locale>(),
    /**
     * Soft-delete marker (ADR-021). Set when an org_admin removes a
     * member; cleared on rejoin. Listing endpoints, /me, and PATCH all
     * filter `deleted_at IS NULL`. The row is preserved so audit_logs
     * FKs and history stay intact. The matching unique index on
     * `(org_id, email)` is a partial index `WHERE deleted_at IS NULL`
     * so the same email can be re-invited after soft-delete.
     */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("users_org_id_idx").on(table.orgId),
    index("users_email_idx").on(table.email),
    // Partial unique — see ADR-021. The same email can be re-invited
    // after soft-delete because rows with `deleted_at IS NOT NULL` are
    // outside the index. Drizzle Kit doesn't model partial indexes, so
    // we declare the unconditional unique here for type-side parity
    // and override with raw SQL in the migration.
    unique("users_org_id_email_uniq").on(table.orgId, table.email),
  ],
);

// ─── Platform admins (ADR-022) ────────────────────────────────────────────────

/**
 * Platform admins — Givernance staff with the Keycloak realm role
 * `super_admin`. Disjoint from `users`: a Keycloak person is either a
 * platform admin or a tenant member, never both (ADR-022). The table sits
 * outside RLS — all reads/writes go through `systemDb` (BYPASSRLS) — and
 * the migration explicitly REVOKEs ALL from the app role so an accidental
 * query through the NOBYPASSRLS pool fails loud rather than returning rows.
 *
 * No `org_id`: platform admins do not belong to any tenant. The Keycloak
 * "Givernance Platform" Organization remains as a logical staff grouping
 * upstream, but it has no app-DB mirror in `tenants` (ADR-022).
 *
 * Soft-delete only (universal Givernance rule, ADR-021): the audit story
 * "list every super-admin we have ever had" must include offboarded staff.
 * The partial unique index on `keycloak_id WHERE deleted_at IS NULL` lets
 * a Keycloak id be re-bound after offboarding without conflict.
 */
export const platformAdmins = pgTable(
  "platform_admins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keycloakId: varchar("keycloak_id", { length: 255 }),
    email: varchar("email", { length: 255 }).notNull(),
    firstName: varchar("first_name", { length: 255 }).notNull(),
    lastName: varchar("last_name", { length: 255 }).notNull(),
    /** Optional last-login marker so the audit story can answer "who's been active". */
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Soft-delete marker (ADR-021 universal). Listing endpoints filter `deleted_at IS NULL`. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("platform_admins_deleted_at_idx").on(table.deletedAt),
    // Drizzle Kit doesn't model partial indexes — the migration declares the
    // partial-unique on `keycloak_id WHERE deleted_at IS NULL` and on
    // `lower(email) WHERE deleted_at IS NULL` directly. The unconditional
    // unique here gives type-side parity for the Drizzle query builder.
    unique("platform_admins_keycloak_id_uniq").on(table.keycloakId),
    unique("platform_admins_email_uniq").on(table.email),
  ],
);

// ─── Invitations ──────────────────────────────────────────────────────────────

/** Purpose discriminator for invitation rows — team invite vs self-serve signup verification (migration 0022). */
export const INVITATION_PURPOSE_VALUES = [
  "team_invite",
  "signup_verification",
  /**
   * Platform-admin invitation (issue #254). Sent when a super-admin
   * invites a new Givernance staffer via the back-office; the invitee
   * accepts on a public Givernance page that handles the
   * "already-authenticated-as-different-user" UX gracefully.
   *
   * Distinct from `team_invite` because the accept flow does NOT
   * insert into `users` — it inserts into `platform_admins` (ADR-022).
   * The `org_id` on the invitations row is the platform sentinel
   * tenant `…a1` (the FK target only; no actual tenant scoping).
   */
  "platform_admin_invite",
] as const;
export type InvitationPurpose = (typeof INVITATION_PURPOSE_VALUES)[number];

/**
 * Invitations — pending email invitations for new users (team_invite) and
 * self-serve signup verification tokens (signup_verification). The `purpose`
 * discriminator (migration 0022) prevents cross-contamination: the
 * `/v1/invitations/:token/accept` endpoint filters to `team_invite` and the
 * `/v1/public/signup/verify` endpoint filters to `signup_verification`.
 */
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: varchar("email", { length: 255 }).notNull(),
    role: userRoleEnum("role").notNull().default("user"),
    token: uuid("token").notNull().defaultRandom().unique(),
    invitedById: uuid("invited_by_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Optional invitee profile seed captured at invite time. Used to
     * pre-fill the public accept form while still letting the invitee
     * edit the values before account creation.
     */
    firstName: varchar("first_name", { length: 255 }),
    lastName: varchar("last_name", { length: 255 }),
    purpose: varchar("purpose", { length: 32 })
      .notNull()
      .default("team_invite")
      .$type<InvitationPurpose>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    /**
     * BCP-47 locale chosen by the inviting org_admin at create time
     * (issue #153 follow-up). Drives the invitation email's language
     * AND seeds the accept-form's locale picker default. NULL means
     * "no admin override" — the recipient's email + accept-form fall
     * back to `tenants.default_locale`.
     *
     * The invitation-time locale never overrides an existing
     * `users.locale` (re-invite case): the user's personal preference
     * is always the highest layer in the resolution chain.
     */
    locale: varchar("locale", { length: 10 }).$type<Locale>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("invitations_org_id_idx").on(table.orgId),
    index("invitations_token_idx").on(table.token),
    index("invitations_purpose_idx").on(table.purpose),
  ],
);

// ─── Tenant Domains ──────────────────────────────────────────────────────────

/**
 * Tenant domains — DNS-verified custom domain claims used by Keycloak Home IdP Discovery
 * and by the self-serve flow to detect "your org is already on Givernance". Personal-email
 * domains (gmail, outlook, …) are blocked by the validator layer, not the DB. Migration 0021
 * (ADR-016).
 */
export const tenantDomains = pgTable(
  "tenant_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 255 }).notNull(),
    state: varchar("state", { length: 32 })
      .notNull()
      .default("pending_dns")
      .$type<TenantDomainState>(),
    dnsTxtValue: varchar("dns_txt_value", { length: 128 }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tenant_domains_org_id_idx").on(table.orgId),
    index("tenant_domains_state_idx").on(table.state),
  ],
);

// ─── Tenant Admin Disputes ───────────────────────────────────────────────────

/**
 * Dispute log for the 7-day provisional-admin grace period on self-serve tenants.
 * Only one open dispute per tenant; closed disputes are retained for audit.
 * User FKs use `ON DELETE SET NULL` so GDPR Art. 17 erasures don't break audit.
 * Migration 0021 (ADR-016).
 */
export const tenantAdminDisputes = pgTable(
  "tenant_admin_disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    disputerId: uuid("disputer_id").references(() => users.id, { onDelete: "set null" }),
    provisionalAdminId: uuid("provisional_admin_id").references(() => users.id, {
      onDelete: "set null",
    }),
    reason: varchar("reason", { length: 2000 }),
    resolution: varchar("resolution", { length: 32 }).$type<TenantAdminDisputeResolution>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("tenant_admin_disputes_org_id_idx").on(table.orgId)],
);

// ─── External Domain Disputes ───────────────────────────────────────────────

/**
 * Dispute log for external users claiming an already registered domain.
 */
export const tenantDisputes = pgTable(
  "tenant_disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    claimerEmail: varchar("claimer_email", { length: 255 }).notNull(),
    claimerFirstName: varchar("claimer_first_name", { length: 255 }),
    claimerLastName: varchar("claimer_last_name", { length: 255 }),
    reason: varchar("reason", { length: 2000 }),
    state: varchar("state", { length: 32 }).notNull().default("open").$type<TenantDisputeState>(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("tenant_disputes_org_id_idx").on(table.orgId),
    index("tenant_disputes_state_idx").on(table.state),
  ],
);

// ─── Audit Logs ───────────────────────────────────────────────────────────────

/** Audit logs — GDPR-compliant immutable record of all data mutations */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    /** Effective subject — the user whose rights were exercised (RFC 8693 `sub`). */
    userId: varchar("user_id", { length: 255 }),
    /**
     * Impersonating actor — non-null when an admin acts on behalf of `userId`
     * via the `act` claim (double-attribution). Equals `userId` under normal
     * auth, distinct under delegation/impersonation.
     */
    actorId: varchar("actor_id", { length: 255 }),
    /**
     * FK to impersonation_sessions when the action was performed inside a
     * support session (issue #24). NULL on normal traffic. Lets readers join
     * audit_logs ↔ impersonation_sessions to reconstruct the full session
     * trail without re-deriving from `actor_id` heuristics.
     */
    impersonationSessionId: uuid("impersonation_session_id"),
    /**
     * Mode discriminator — "delegation" | "impersonation" | NULL. Stored
     * alongside `impersonation_session_id` so SIEM filters can group by mode
     * without joining. Always NULL when `impersonation_session_id` is NULL.
     */
    impersonationMode: varchar("impersonation_mode", { length: 32 }),
    action: varchar("action", { length: 255 }).notNull(),
    resourceType: varchar("resource_type", { length: 100 }),
    resourceId: varchar("resource_id", { length: 255 }),
    oldValues: jsonb("old_values"),
    newValues: jsonb("new_values"),
    ipHash: varchar("ip_hash", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_org_id_idx").on(table.orgId),
    index("audit_logs_user_id_idx").on(table.userId),
    index("audit_logs_actor_id_idx").on(table.actorId),
    index("audit_logs_resource_idx").on(table.resourceType, table.resourceId),
    index("audit_logs_imp_session_idx").on(table.impersonationSessionId),
  ],
);

// ─── Merge History ──────────────────────────────────────────────────────────

/**
 * Constituent merge history — GDPR Art. 5(2) accountability snapshot.
 * Preserves the before-state of both the survivor and the merged-away record,
 * plus the post-merge survivor state, so that audit reviewers can reconstruct
 * exactly which PII was combined and who authorised it.
 */
export const mergeHistory = pgTable(
  "merge_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    survivorId: uuid("survivor_id").notNull(),
    mergedId: uuid("merged_id").notNull(),
    mergedByUserId: varchar("merged_by_user_id", { length: 255 }).notNull(),
    mergedByActorId: varchar("merged_by_actor_id", { length: 255 }),
    survivorBefore: jsonb("survivor_before").notNull(),
    mergedBefore: jsonb("merged_before").notNull(),
    survivorAfter: jsonb("survivor_after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("merge_history_org_id_idx").on(table.orgId),
    index("merge_history_survivor_id_idx").on(table.survivorId),
    index("merge_history_merged_id_idx").on(table.mergedId),
  ],
);

// ─── Exchange Rates ──────────────────────────────────────────────────────────

/** Exchange rates — historical currency conversion rates by day */
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    currency: varchar("currency", { length: 3 }).notNull(),
    baseCurrency: varchar("base_currency", { length: 3 }).notNull(),
    rate: numeric("rate", { precision: 18, scale: 8 }).notNull(),
    date: date("date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("exchange_rates_currency_idx").on(table.currency),
    index("exchange_rates_base_currency_idx").on(table.baseCurrency),
    index("exchange_rates_date_idx").on(table.date),
    unique("exchange_rates_currency_base_date_uniq").on(
      table.currency,
      table.baseCurrency,
      table.date,
    ),
  ],
);

// ─── Constituents ─────────────────────────────────────────────────────────────

export { type OutboxMetadata, outboxEvents } from "./outbox";

// ─── Org branding (Epic #286) ─────────────────────────────────────────────────

export {
  BRANDING_ASSET_STATUS_VALUES,
  BRANDING_ASSET_TYPE_VALUES,
  type BrandingAssetStatus,
  type BrandingAssetType,
  type BrandingAssetVariants,
  type BrandingVariantKey,
  type NewOrgBrandingAsset,
  type OrgBrandingAsset,
  orgBrandingAssets,
} from "./branding";

// ─── Notification centre (Epic #363) ──────────────────────────────────────────

export {
  type NewNotification,
  type NewNotificationPreference,
  type Notification,
  type NotificationPreference,
  notificationPreferences,
  notifications,
} from "./notifications";

// ─── Swiss QR-bill foundation (Epic #318) ────────────────────────────────────
//
// The cross-table FKs `campaigns.bank_account_id`, `donations.swiss_qr_reference_id`,
// and `donations.camt_credit_entry_id` need the swiss-qr-bill table values at
// table-definition time below. ES modules resolve this circular import via
// lazy `references((): AnyPgColumn => ...)` callbacks — the table definitions
// in `swiss-qr-bill.ts` themselves only use lazy refs back into this file.
import {
  bankAccounts,
  campaignQrReferenceModeEnum,
  camtCreditEntries,
  donationPaymentSourceEnum,
  swissQrReferences,
} from "./swiss-qr-bill";

export {
  BANK_ACCOUNT_CURRENCY_VALUES,
  BANK_ACCOUNT_IBAN_KIND_VALUES,
  type BankAccount,
  type BankAccountCurrency,
  type BankAccountIbanKind,
  bankAccountCurrencyEnum,
  bankAccountIbanKindEnum,
  bankAccounts,
  CAMPAIGN_QR_REFERENCE_MODE_VALUES,
  CAMT_STATEMENT_STATUS_VALUES,
  CAMT_UNRECONCILED_REASON_VALUES,
  CAMT_UNRECONCILED_STATUS_VALUES,
  type CampaignQrReferenceMode,
  type CamtCreditEntry,
  type CamtStatement,
  type CamtStatementStatus,
  type CamtUnreconciledEntry,
  type CamtUnreconciledReason,
  type CamtUnreconciledStatus,
  campaignQrReferenceModeEnum,
  camtCreditEntries,
  camtStatementStatusEnum,
  camtStatements,
  camtUnreconciledEntries,
  camtUnreconciledReasonEnum,
  camtUnreconciledStatusEnum,
  DONATION_PAYMENT_SOURCE_VALUES,
  type DonationPaymentSource,
  donationPaymentSourceEnum,
  type NewBankAccount,
  type NewCamtCreditEntry,
  type NewCamtStatement,
  type NewCamtUnreconciledEntry,
  type NewSwissQrReference,
  SWISS_QR_REFERENCE_TYPE_VALUES,
  type SwissQrReference,
  type SwissQrReferenceType,
  swissQrReferences,
  swissQrReferenceTypeEnum,
} from "./swiss-qr-bill";

// ─── Impersonation sessions (issue #24) ──────────────────────────────────────
import {
  IMPERSONATION_END_REASON_VALUES as _IMPERSONATION_END_REASON_VALUES,
  IMPERSONATION_MODE_VALUES as _IMPERSONATION_MODE_VALUES,
} from "../constants/impersonation";

export {
  IMPERSONATION_END_REASON_VALUES,
  IMPERSONATION_MODE_VALUES,
  type ImpersonationEndReason,
  type ImpersonationMode,
} from "../constants/impersonation";

export const impersonationModeEnum = pgEnum("impersonation_mode", [..._IMPERSONATION_MODE_VALUES]);

export const impersonationEndReasonEnum = pgEnum("impersonation_end_reason", [
  ..._IMPERSONATION_END_REASON_VALUES,
]);

/**
 * Platform-level table tracking every super-admin support session against
 * a tenant. Two coexisting modes — see docs/19-impersonation.md. Append-
 * only at the DB level (trigger from migration 0033).
 */
export const impersonationSessions = pgTable(
  "impersonation_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    impersonatorKeycloakId: varchar("impersonator_keycloak_id", { length: 255 }).notNull(),
    targetKeycloakId: varchar("target_keycloak_id", { length: 255 }).notNull(),
    targetOrgId: uuid("target_org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    targetRole: varchar("target_role", { length: 50 }).notNull(),
    mode: impersonationModeEnum("mode").notNull(),
    reason: text("reason").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endReason: impersonationEndReasonEnum("end_reason"),
    ipHash: varchar("ip_hash", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("imp_sessions_impersonator_idx").on(table.impersonatorKeycloakId),
    index("imp_sessions_target_user_idx").on(table.targetKeycloakId),
    index("imp_sessions_target_org_idx").on(table.targetOrgId),
    index("imp_sessions_expires_at_idx").on(table.expiresAt),
    index("imp_sessions_mode_idx").on(table.mode),
  ],
);

/** Constituents — donors, volunteers, members, beneficiaries */
export const constituents = pgTable("constituents", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  firstName: varchar("first_name", { length: 255 }).notNull(),
  lastName: varchar("last_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  // ── Postal address (Epic #274 follow-up) ────────────────────────────
  // Used to render the recipient block in the window of a French DL
  // window envelope (norme NF Z-10-011). The renderer skips the block
  // when these are NULL — the resulting PDF still prints, just without
  // the in-window address. All five fields are independent (a P.O. box
  // tenant might leave `addressLine1` populated and `addressLine2` NULL)
  // and the operator opts in per-constituent via the create/edit form.
  addressLine1: varchar("address_line1", { length: 255 }),
  addressLine2: varchar("address_line2", { length: 255 }),
  postalCode: varchar("postal_code", { length: 20 }),
  city: varchar("city", { length: 255 }),
  /** ISO 3166-1 alpha-2 country code. Same convention as `tenants.country`. */
  countryCode: varchar("country_code", { length: 2 }),
  type: varchar("type", { length: 50 }).notNull().default("donor"),
  tags: text("tags").array(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Donations — financial contributions linked to a constituent */
export const donations = pgTable(
  "donations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    constituentId: uuid("constituent_id")
      .notNull()
      .references(() => constituents.id),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("EUR"),
    exchangeRate: numeric("exchange_rate", { precision: 18, scale: 8 }),
    amountBaseCents: integer("amount_base_cents").notNull(),
    campaignId: uuid("campaign_id").references((): AnyPgColumn => campaigns.id, {
      onDelete: "set null",
    }),
    /**
     * Optional FK to the printed campaign QR code that produced this gift
     * (Epic #274). NULL for donations not initiated through a scanned letter.
     * Surfaces in the campaign QR-tracking widget so the admin can answer
     * "how many gifts originated from postal scans?". `campaignId` stays the
     * authoritative campaign attribution; this column carries the channel.
     */
    qrCodeId: uuid("qr_code_id").references((): AnyPgColumn => campaignQrCodes.id, {
      onDelete: "set null",
    }),
    /**
     * Optional FK to the Swiss QR-bill reference that produced this gift
     * (Epic #318). Set by the camt.053 reconciler when a credit entry's
     * structured reference matches a row in `swiss_qr_references`. NULL
     * for Stripe-rail donations and manual entries.
     */
    swissQrReferenceId: uuid("swiss_qr_reference_id").references(
      (): AnyPgColumn => swissQrReferences.id,
      { onDelete: "set null" },
    ),
    /**
     * Optional FK to the camt.053 credit entry this donation settles
     * (Epic #318). 1:1 with the receiving rail — useful for "show me the
     * raw bank line behind this donation" audits. NULL for non-camt rails.
     */
    camtCreditEntryId: uuid("camt_credit_entry_id").references(
      (): AnyPgColumn => camtCreditEntries.id,
      { onDelete: "set null" },
    ),
    /**
     * Origin rail discriminator (Epic #318). `stripe` (default, back-compat
     * with every existing row), `camt053` (Swiss bank-transfer rail), or
     * `manual` (operator-entered). Distinct from `paymentMethod` which is
     * a free-form string; this is the structured signal the reporting and
     * reconciliation surfaces filter on.
     */
    paymentSource: donationPaymentSourceEnum("payment_source").notNull().default("stripe"),
    status: donationStatusEnum("status").notNull().default("cleared"),
    platformFeeCents: integer("platform_fee_cents").notNull().default(0),
    paymentMethod: varchar("payment_method", { length: 50 }),
    paymentRef: varchar("payment_ref", { length: 255 }),
    donatedAt: timestamp("donated_at", { withTimezone: true }).notNull().defaultNow(),
    fiscalYear: integer("fiscal_year"),
    receiptNumber: varchar("receipt_number", { length: 100 }),
    receiptAmount: numeric("receipt_amount", { precision: 12, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("donations_org_id_idx").on(table.orgId),
    index("donations_constituent_id_idx").on(table.constituentId),
    index("donations_donated_at_idx").on(table.donatedAt),
    index("donations_campaign_id_idx").on(table.campaignId),
    index("donations_qr_code_id_idx").on(table.qrCodeId),
    // FK indexes for the Swiss QR-bill rail (Epic #318). The reconciler
    // performs `UPDATE donations … WHERE swiss_qr_reference_id = ?` per
    // matched credit; without these, every reconcile is O(donations).
    index("donations_swiss_qr_reference_id_idx").on(table.swissQrReferenceId),
    index("donations_camt_credit_entry_id_idx").on(table.camtCreditEntryId),
    unique("donations_org_payment_uniq").on(table.orgId, table.paymentMethod, table.paymentRef),
  ],
);

// ─── Funds ───────────────────────────────────────────────────────────────────

/** Funds — restricted or unrestricted fund designations for donation allocations */
export const funds = pgTable(
  "funds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    type: fundTypeEnum("type").notNull().default("unrestricted"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("funds_org_id_idx").on(table.orgId),
    unique("funds_org_name_uniq").on(table.orgId, table.name),
  ],
);

// ─── Donation Allocations ────────────────────────────────────────────────────

/** Donation Allocations — split a donation across one or more funds */
export const donationAllocations = pgTable(
  "donation_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    donationId: uuid("donation_id")
      .notNull()
      .references(() => donations.id, { onDelete: "cascade" }),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("donation_allocations_org_id_idx").on(table.orgId),
    index("donation_allocations_donation_id_idx").on(table.donationId),
    index("donation_allocations_fund_id_idx").on(table.fundId),
  ],
);

// ─── Pledges ─────────────────────────────────────────────────────────────────

/** Pledges — recurring commitment from a constituent */
export const pledges = pgTable(
  "pledges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    constituentId: uuid("constituent_id")
      .notNull()
      .references(() => constituents.id),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("EUR"),
    frequency: pledgeFrequencyEnum("frequency").notNull(),
    status: pledgeStatusEnum("status").notNull().default("active"),
    stripeCustomerId: varchar("stripe_customer_id", { length: 255 }),
    stripeAccountId: varchar("stripe_account_id", { length: 255 }),
    paymentGateway: varchar("payment_gateway", { length: 50 }),
    stripeMandateId: varchar("stripe_mandate_id", { length: 255 }),
    mandateAcceptedAt: timestamp("mandate_accepted_at", { withTimezone: true }),
    mandateIpHash: varchar("mandate_ip_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pledges_org_id_idx").on(table.orgId),
    index("pledges_constituent_id_idx").on(table.constituentId),
  ],
);

// ─── Pledge Installments ─────────────────────────────────────────────────────

/** Pledge Installments — expected payments for a pledge */
export const pledgeInstallments = pgTable(
  "pledge_installments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    pledgeId: uuid("pledge_id")
      .notNull()
      .references(() => pledges.id, { onDelete: "cascade" }),
    donationId: uuid("donation_id").references(() => donations.id, { onDelete: "set null" }),
    expectedAt: timestamp("expected_at", { withTimezone: true }).notNull(),
    status: installmentStatusEnum("installment_status").notNull().default("pending"),
    /** Per-installment amount (cents). Allows bumped/variable installments. */
    amountCents: integer("amount_cents").notNull(),
    /** Optional fund allocation for this installment. Reconciles against donation_allocations. */
    fundId: uuid("fund_id").references(() => funds.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pledge_installments_org_id_idx").on(table.orgId),
    index("pledge_installments_pledge_id_idx").on(table.pledgeId),
    index("pledge_installments_fund_id_idx").on(table.fundId),
  ],
);

// ─── Receipts ───────────────────────────────────────────────────────────────

/** Receipts — generated tax receipt PDFs linked to donations */
export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    donationId: uuid("donation_id")
      .notNull()
      .references(() => donations.id, { onDelete: "cascade" }),
    receiptNumber: varchar("receipt_number", { length: 100 }).notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    s3Path: varchar("s3_path", { length: 500 }).notNull(),
    status: receiptStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("receipts_org_id_idx").on(table.orgId),
    index("receipts_donation_id_idx").on(table.donationId),
    unique("receipts_org_fiscal_number_uniq").on(
      table.orgId,
      table.fiscalYear,
      table.receiptNumber,
    ),
  ],
);

// ─── Receipt Sequences ─────────────────────────────────────────────────────

/** Receipt Sequences — gapless counter per org/fiscal year for sequential receipt numbering */
export const receiptSequences = pgTable(
  "receipt_sequences",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fiscalYear: integer("fiscal_year").notNull(),
    nextVal: integer("next_val").notNull().default(1),
  },
  (table) => [unique("receipt_sequences_pkey").on(table.orgId, table.fiscalYear)],
);

// ─── Campaigns ──────────────────────────────────────────────────────────────

/** Campaigns — postal (nominative or door-drop) and digital campaigns */
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 255 }).notNull(),
    /**
     * Free-form admin-side description of the campaign (Epic #274 follow-up).
     * Distinct from `campaign_public_pages.description` which is the
     * donor-facing copy: the admin description is the source of truth used
     * to enrich postal-letter PDFs and to seed the public page on first
     * publish. Soft-capped at 2000 chars by the validator. NULL until the
     * operator fills it.
     */
    description: text("description"),
    type: campaignTypeEnum("type").notNull(),
    status: campaignStatusEnum("status").notNull().default("draft"),
    defaultCurrency: varchar("default_currency", { length: 3 }).notNull().default("EUR"),
    parentId: uuid("parent_id").references((): AnyPgColumn => campaigns.id, {
      onDelete: "set null",
    }),
    /**
     * Optional FK to the Swiss bank account that backs QR-bill issuance
     * for this campaign (Epic #318). The presence of a value IS the
     * "Swiss QR-bill mode on" switch — there is no separate boolean
     * toggle (an `enabled=true && bankAccountId=NULL` state has no
     * operator meaning). ON DELETE SET NULL: soft-deleting the bank
     * account in `Settings → Bank Accounts` degrades the campaign back
     * to standard mode rather than refusing the delete.
     */
    bankAccountId: uuid("bank_account_id").references((): AnyPgColumn => bankAccounts.id, {
      onDelete: "set null",
    }),
    /**
     * Per-campaign override for the QR reference type (Epic #318).
     * `auto` (default) derives from `bank_accounts.iban_kind` — QRR for
     * QR-IBANs, SCOR for regular IBANs. Operators rarely need to
     * override; the field exists for the few cases where the bank
     * supports both and the org wants a specific format. Ignored when
     * `bankAccountId IS NULL`.
     */
    qrReferenceMode: campaignQrReferenceModeEnum("qr_reference_mode").notNull().default("auto"),
    /**
     * Per-campaign override of the public-page archetype (Epic #362).
     * NULL = "inherit `tenants.default_public_page_style`, falling
     * back to ''foundation'' if that's also NULL." Donor-facing API
     * only emits this through to the public response when the
     * `donation.public_page_styles` feature flag is on for the
     * owning tenant; with the flag off, the field is omitted and
     * the donor page falls back to today's hardcoded layout.
     */
    publicPageStyle: publicPageStyleEnum("public_page_style"),
    operationalCostCents: bigint("operational_cost_cents", { mode: "number" }),
    platformFeesCents: bigint("platform_fees_cents", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaigns_org_id_idx").on(table.orgId),
    index("campaigns_org_parent_id_idx").on(table.orgId, table.parentId),
    // FK index — supports the ON DELETE SET NULL cascade when a bank
    // account is soft-deleted; without it, every soft-delete triggers
    // a full scan on `campaigns`.
    index("campaigns_bank_account_id_idx").on(table.bankAccountId),
  ],
);

// ─── Campaign Funds ──────────────────────────────────────────────────────────

/** Campaign Funds — eligible funds that can be designated for a campaign */
export const campaignFunds = pgTable(
  "campaign_funds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    fundId: uuid("fund_id")
      .notNull()
      .references(() => funds.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaign_funds_org_id_idx").on(table.orgId),
    index("campaign_funds_campaign_id_idx").on(table.campaignId),
    index("campaign_funds_fund_id_idx").on(table.fundId),
    unique("campaign_funds_org_campaign_fund_uniq").on(table.orgId, table.campaignId, table.fundId),
  ],
);

// ─── Campaign Documents ─────────────────────────────────────────────────────

/** Campaign Documents — generated PDF letters linked to a campaign (and optionally a constituent) */
export const campaignDocuments = pgTable(
  "campaign_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    constituentId: uuid("constituent_id").references(() => constituents.id, {
      onDelete: "set null",
    }),
    s3Path: varchar("s3_path", { length: 500 }).notNull(),
    status: campaignDocumentStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaign_documents_org_id_idx").on(table.orgId),
    index("campaign_documents_campaign_id_idx").on(table.campaignId),
  ],
);

// ─── Campaign QR Codes ──────────────────────────────────────────────────────

/** Campaign QR Codes — unique trackable codes embedded in campaign letters */
export const campaignQrCodes = pgTable(
  "campaign_qr_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    constituentId: uuid("constituent_id").references(() => constituents.id, {
      onDelete: "set null",
    }),
    /**
     * Opaque nanoid token (21 chars). No tenant / constituent identifiers are
     * encoded; the code is resolved server-side against `(org_id, code)` so a
     * stolen QR reveals nothing about who received it. Scoped per-org to avoid
     * leaking tenant existence via collision errors.
     */
    code: varchar("code", { length: 32 }).notNull(),
    /**
     * Backlink to the `campaign_postal_exports` row that minted this token
     * (Epic #274 audit follow-up — migration 0040). Lets the worker detect
     * on retry that QR codes have already been generated for this export
     * and reuse them instead of duplicating tokens on every BullMQ retry.
     *
     * NULL for QR codes minted outside the postal-export pipeline (legacy
     * manual flow, future ad-hoc generators); the partial unique index
     * `campaign_qr_codes_export_recipient_uniq` only enforces uniqueness
     * when this column is set.
     */
    exportId: uuid("export_id"),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaign_qr_codes_org_id_idx").on(table.orgId),
    index("campaign_qr_codes_campaign_id_idx").on(table.campaignId),
    index("campaign_qr_codes_export_id_idx").on(table.exportId),
    unique("campaign_qr_codes_org_code_uniq").on(table.orgId, table.code),
  ],
);

// ─── Campaign Constituents (Epic #274) ─────────────────────────────────────

/**
 * Campaign Constituents — explicit membership of a constituent in a campaign,
 * independent of any donation or generated document. Lets the admin build
 * the postal recipient list before any letter is generated.
 */
export const campaignConstituents = pgTable(
  "campaign_constituents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    constituentId: uuid("constituent_id")
      .notNull()
      .references(() => constituents.id, { onDelete: "cascade" }),
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaign_constituents_org_idx").on(table.orgId),
    index("campaign_constituents_campaign_idx").on(table.campaignId),
    index("campaign_constituents_constituent_idx").on(table.constituentId),
    unique("campaign_constituents_org_campaign_constituent_uniq").on(
      table.orgId,
      table.campaignId,
      table.constituentId,
    ),
  ],
);

// ─── Campaign Postal Exports (Epic #274) ───────────────────────────────────

/**
 * Campaign Postal Exports — async ZIP-archive generation jobs for postal
 * campaigns. The frontend polls a row's `status` + `progressCount` to render
 * a progress bar; the worker mutates them as it streams PDFs through
 * the ZIP bundler. Final ZIP key is in `zipS3Path`.
 */
export const campaignPostalExports = pgTable(
  "campaign_postal_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    mode: postalExportModeEnum("mode").notNull(),
    status: postalExportStatusEnum("status").notNull().default("pending"),
    /**
     * Resolved run mode (Epic #318 PR #4 MAJOR-1 follow-up) — `standard` /
     * `qr_bill_only` / `hybrid`. Stamped at API enqueue time so the worker
     * can assert at pickup that the live inputs (`bank_account_id`,
     * public-page presence) haven't drifted since the operator clicked
     * Generate. NULL on rows that pre-date migration 0045 (legacy
     * history); the worker treats NULL as "skip the drift assertion".
     * Never `blocked` — that mode short-circuits at the API readiness
     * gate before a row is ever inserted.
     */
    runMode: text("run_mode"),
    /**
     * Total expected PDFs (= constituent count for personalized, 1 for
     * door-drop). Locked at job-start so the progress bar denominator stays
     * stable even if the campaign membership is mutated mid-job.
     */
    totalCount: integer("total_count").notNull().default(0),
    progressCount: integer("progress_count").notNull().default(0),
    zipS3Path: varchar("zip_s3_path", { length: 500 }),
    error: text("error"),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("campaign_postal_exports_org_idx").on(table.orgId),
    index("campaign_postal_exports_campaign_idx").on(table.campaignId),
    index("campaign_postal_exports_created_at_idx").on(table.createdAt),
  ],
);

// ─── Bulk Email Jobs (issue #326) ──────────────────────────────────────────

/**
 * Bulk-email job lifecycle. `pending` → `processing` → terminal.
 *
 * Terminal states split delivery outcome:
 *   - `completed` — every requested recipient was delivered.
 *   - `partial`   — some delivered, some did not (SMTP refused OR worker
 *                   never reached them because the BullMQ job was dropped
 *                   by a Redis wipe / OOM / accessory reboot). Surfaces a
 *                   "Resume / re-send to remaining recipients" action.
 *   - `failed`    — terminal failure before per-recipient sends could
 *                   start (DB error, malformed row). Resume still works
 *                   because `delivered_count = 0` ⇒ remaining = total.
 */
export const BULK_EMAIL_JOB_STATUS_VALUES = [
  "pending",
  "processing",
  "completed",
  "partial",
  "failed",
] as const;
export type BulkEmailJobStatus = (typeof BULK_EMAIL_JOB_STATUS_VALUES)[number];

export const bulkEmailJobStatusEnum = pgEnum("bulk_email_job_status", [
  ...BULK_EMAIL_JOB_STATUS_VALUES,
]);

/**
 * Bulk email job — per-dispatch record carrying the recipient snapshot
 * and the per-recipient delivery outcome. Replaces "fire-and-forget +
 * trust the outbox" with a queryable progress + resume surface so a
 * Redis wipe / OOM / accessory reboot mid-fan-out doesn't silently lose
 * recipients (issue #326).
 *
 * Storage trade-off vs. GDPR Art. 5(1)(e):
 *   - `constituent_ids` (uuid[]) is the *snapshot* of deliverable ids at
 *     request time. Stored in the DB so the resume path can compute the
 *     remaining set without depending on the outbox row (which is
 *     short-lived: the relay marks it `completed` the moment it enqueues).
 *   - PII (email, name) is NOT persisted here — the worker re-resolves
 *     it from `constituents` under RLS at send time, same as before. A
 *     uuid is a tenant-scoped foreign key, not personal data.
 *   - On GDPR erasure of a constituent, the worker silently drops them
 *     at send time (already covered by `processSendBulkEmail`'s
 *     soft-delete filter); the uuid lingering in the array is a tenant-
 *     local reference, not directly identifying.
 */
export const bulkEmailJobs = pgTable(
  "bulk_email_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    status: bulkEmailJobStatusEnum("status").notNull().default("pending"),
    /** Admin-supplied subject. Capped at 200 by the route validator and the DB column width. */
    subject: varchar("subject", { length: 200 }).notNull(),
    /**
     * Admin-supplied plain-text body. Capped at 50 000 by the route
     * validator; `text` here avoids a tighter DB cap that would surprise
     * the resume path (a resume carries the original body forward).
     */
    body: text("body").notNull(),
    /**
     * Requested deliverable recipients — the constituent ids the API
     * filtered down to "has email on file" at request time. Locked at
     * insert; the worker iterates this list and writes outcomes into
     * `delivered_constituent_ids` / `failed_constituent_ids`. Resume
     * computes `constituent_ids \ delivered_constituent_ids`.
     */
    constituentIds: uuid("constituent_ids").array().notNull(),
    /** Append-only set of recipients the worker successfully sent to. */
    deliveredConstituentIds: uuid("delivered_constituent_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** Append-only set of recipients the worker tried and SMTP refused. */
    failedConstituentIds: uuid("failed_constituent_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** = `constituent_ids` length. Denormalised so the polling UI reads O(1). */
    totalRecipients: integer("total_recipients").notNull(),
    /** = `delivered_constituent_ids` length. Worker keeps it in step on every send. */
    deliveredCount: integer("delivered_count").notNull().default(0),
    /** = `failed_constituent_ids` length. Worker keeps it in step on every send. */
    failedCount: integer("failed_count").notNull().default(0),
    /**
     * JWT subject → internal users.id translation. Same convention as
     * `campaign_postal_exports.requested_by`: SET NULL on user purge so
     * GDPR erasure of a staff account doesn't FK-block the audit row.
     */
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * Audit chain for resume jobs. Each resume creates a fresh row whose
     * `parent_job_id` points at the row that left recipients on the
     * table. NULL on the originating dispatch.
     */
    parentJobId: uuid("parent_job_id").references((): AnyPgColumn => bulkEmailJobs.id, {
      onDelete: "set null",
    }),
    /** Terminal failure message. NULL until status flips to `failed`. */
    error: text("error"),
    /** Soft-delete (ADR-021 universal). Listing filters `deleted_at IS NULL`. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("bulk_email_jobs_org_idx").on(table.orgId),
    index("bulk_email_jobs_created_at_idx").on(table.createdAt),
    index("bulk_email_jobs_parent_idx").on(table.parentJobId),
  ],
);

// ─── Bulk Import Constituents (Epic #373) ──────────────────────────────────

export const BULK_IMPORT_JOB_STATUS_VALUES = [
  "pending",
  "processing",
  "completed",
  "partial",
  "failed",
] as const;
export type BulkImportJobStatus = (typeof BULK_IMPORT_JOB_STATUS_VALUES)[number];

export const bulkImportJobStatusEnum = pgEnum("bulk_import_job_status", [
  ...BULK_IMPORT_JOB_STATUS_VALUES,
]);

export const BULK_IMPORT_RESULT_STATUS_VALUES = ["created", "duplicate", "failed"] as const;
export type BulkImportResultStatus = (typeof BULK_IMPORT_RESULT_STATUS_VALUES)[number];

/**
 * Bulk-import file row — the S3 object reference + audit metadata for an
 * uploaded CSV / Excel template. One row per upload, regardless of
 * whether the parsing job completed. Kept for audit / re-download.
 *
 * Storage trade-off vs. GDPR Art. 5(1)(e):
 *   - The file itself sits in S3 (bucket `S3_BULK_IMPORT_BUCKET`,
 *     private, key prefix `{org_id}/bulk-imports/{job_id}/…`) and is
 *     subject to the bucket's retention policy (90 days, see
 *     `docs/28-bulk-import.md` §6). This row only carries the pointer.
 *   - On constituent erasure the file is NOT auto-purged — the row
 *     still has audit value (who-uploaded-what-when). The bucket
 *     lifecycle policy is the GDPR retention boundary.
 */
export const bulkImportFiles = pgTable(
  "bulk_import_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** S3 key: `{org_id}/bulk-imports/{job_id}/{sanitised_filename}`. */
    s3Key: varchar("s3_key", { length: 500 }).notNull(),
    /** Bucket the object landed in — captured at write time so a future env-var change doesn't break older rows. */
    s3Bucket: varchar("s3_bucket", { length: 100 }).notNull(),
    /** Sanitised original filename (basename only — no path components). */
    fileName: varchar("file_name", { length: 255 }).notNull(),
    fileSize: integer("file_size").notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    /** Template version used (for future compatibility). */
    templateVersion: varchar("template_version", { length: 20 }).notNull().default("1.0"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("bulk_import_files_org_idx").on(table.orgId),
    index("bulk_import_files_created_at_idx").on(table.createdAt),
  ],
);

/**
 * Bulk-import job — orchestration row for one upload. The HTTP handler
 * uploads the file to S3, inserts the `bulk_import_files` row, inserts
 * THIS row plus a `constituents.bulk_import_requested` outbox event in
 * one transaction. The outbox relay forwards to BullMQ; the worker
 * reads the row, re-parses the file under tenant context, and
 * increments `processed_rows` / `created_count` / `duplicate_count` /
 * `failed_count` per row.
 *
 * The defense-in-depth CHECK constraint ensures the counters never
 * disagree with `processed_rows`. The worker bumps `updated_at` on
 * every batch so the UI's 2 s poll always sees fresh progress even
 * during long imports.
 */
export const bulkImportJobs = pgTable(
  "bulk_import_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    status: bulkImportJobStatusEnum("status").notNull().default("pending"),
    totalRows: integer("total_rows").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /** Rows that landed with addressLine1 + postalCode + city + countryCode all filled. */
    completeAddressCount: integer("complete_address_count").notNull().default(0),
    /** Rows that landed with a non-empty email. */
    emailCount: integer("email_count").notNull().default(0),
    fileId: uuid("file_id")
      .notNull()
      .references(() => bulkImportFiles.id, { onDelete: "cascade" }),
    /** SET NULL on user purge so GDPR erasure doesn't FK-block the audit row. */
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    /** Terminal failure message. NULL until status flips to `failed`. */
    error: text("error"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("bulk_import_jobs_org_idx").on(table.orgId),
    index("bulk_import_jobs_created_at_idx").on(table.createdAt),
    index("bulk_import_jobs_status_idx").on(table.status),
  ],
);

/**
 * Per-row result of a bulk-import job. One row per source row, regardless
 * of outcome (`created`, `duplicate`, `failed`). Carries enough context
 * for the operator to remediate (the original row data, the error code
 * and message, and the FK to the constituent that was created OR that
 * the row was deduped against).
 *
 * GDPR posture: `rowData` is a JSONB snapshot of the user-uploaded row
 * (PII). It is purged by the bucket lifecycle policy on the source file
 * (90 days), and additionally truncated by the `bulk_import_files`
 * soft-delete cascade. See `docs/28-bulk-import.md` §6 for the full
 * retention table.
 */
export const bulkImportResults = pgTable(
  "bulk_import_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => bulkImportJobs.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    /** Snapshot of the original row as parsed (PII). 90-day retention. */
    rowData: jsonb("row_data").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    constituentId: uuid("constituent_id").references((): AnyPgColumn => constituents.id, {
      onDelete: "set null",
    }),
    duplicateOfId: uuid("duplicate_of_id").references((): AnyPgColumn => constituents.id, {
      onDelete: "set null",
    }),
    duplicateScore: numeric("duplicate_score", { precision: 3, scale: 2 }),
    errorCode: varchar("error_code", { length: 50 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("bulk_import_results_job_idx").on(table.jobId),
    index("bulk_import_results_org_idx").on(table.orgId),
    index("bulk_import_results_status_idx").on(table.status),
  ],
);

// ─── Feature Flags (doc 18 — global-only MVP) ──────────────────────────────

/**
 * Platform-wide feature flag registry. **Phase-1 MVP scope: global flags
 * only** — every tenant sees the same value. Per-tenant overrides
 * (`tenant_flag_overrides`) and plan-gating are deferred to the
 * next-iteration spec in `docs/18-feature-flags.md`.
 *
 * Why global-only first:
 *   - The first real consumer (bulk-email, gated until DKIM/SPF lands —
 *     see PR #352 discussion with @magino) is a platform-wide pause,
 *     not a per-tenant trial.
 *   - Schema is forward-compatible: a future `tenant_flag_overrides`
 *     table joins on `key` without backfilling.
 *
 * Reads are cached in Redis with a 60s TTL keyed `flags:global` (single
 * map covering every flag in the registry). Cache is invalidated on
 * every write by the admin API. The seed migration inserts the
 * canonical set; the admin UI only toggles `enabled`, it does NOT
 * create or delete flags — drift between code and DB is the failure
 * mode the registry exists to prevent.
 */
/**
 * Allowed values for `feature_flags.scope` — kept in lockstep with
 * `FEATURE_FLAG_SCOPES` in `packages/shared/src/constants/feature-flags.ts`.
 * Defined here as a `pgEnum` so the Drizzle migration generator picks it up.
 */
export const featureFlagScopeEnum = pgEnum("feature_flag_scope", ["platform", "tenant"]);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Dotted-namespace key, e.g. `communication.bulk_email`. Lowercase,
     * dot-separated, no whitespace. The `requireFlag(key)` middleware
     * looks rows up by this column; the seed migration is the source of
     * truth for what keys exist.
     */
    key: varchar("key", { length: 100 }).notNull().unique(),
    /**
     * Platform-default value. The evaluator overlays tenant overrides
     * on top of this for `scope='tenant'` rows; for `scope='platform'`
     * rows this is the only source of truth.
     */
    enabled: boolean("enabled").notNull().default(false),
    /**
     * Short, friendly title shown as the row heading in the Back Office
     * UI (e.g. "Bulk emails to constituents"). Plain language, no
     * dotted-namespace prefix, no engineering jargon — operators are
     * the audience.
     */
    label: varchar("label", { length: 120 }).notNull(),
    /**
     * Operator-facing description shown under the label in the
     * Back Office UI AND the org-admin `/settings/feature-flags`
     * page (Epic #365). One or two sentences in plain language,
     * focused on **what the feature does for the operator**. The
     * engineering rationale (RFCs, incident IDs, infra prerequisites)
     * belongs in `FEATURE_FLAG_REGISTRY` code comments, NOT in this
     * column.
     */
    description: text("description").notNull(),
    /**
     * Controls who can flip this flag. Epic #365 (Phase 2):
     *   - `platform`: super-admin only. Tenant overrides are
     *     IGNORED by the evaluator even if rows exist.
     *   - `tenant`: super-admin can set tenant overrides; org-admin
     *     can ALSO set them IF `tenant_override_allowed=true`.
     * Default `platform` for safety — a newly registered flag is
     * platform-locked until explicitly opened up.
     */
    scope: featureFlagScopeEnum("scope").notNull().default("platform"),
    /**
     * Extra gate on tenant-scoped flags. `scope='tenant' AND
     * tenant_override_allowed=true` is what makes a flag appear in
     * the org-admin `/settings/feature-flags` page. Super-admin can
     * still set tenant overrides on `scope='tenant' AND
     * tenant_override_allowed=false` rows when there's a platform
     * precondition (DKIM posture, etc.) that the operator must
     * verify per-tenant.
     */
    tenantOverrideAllowed: boolean("tenant_override_allowed").notNull().default(false),
    /**
     * Controls whether `GET /v1/feature-flags` emits this row to
     * non-admin tenant callers. Resolves the public-projection
     * caveat from doc 18 § 0 — unreleased flag names no longer leak
     * via DevTools. Default `false` (private) so a newly registered
     * flag stays hidden until explicitly opened up to tenants.
     */
    public: boolean("public").notNull().default(false),
    /**
     * Last super-admin to flip the flag. `SET NULL` on user purge so a
     * GDPR-erased staff account doesn't FK-block the row. Audit history
     * lives in `audit_logs` keyed on `feature_flag.toggled`.
     */
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // No explicit key-index — the `UNIQUE` constraint on `key` already
  // creates one and that's what `flagService` + `requireFlag` look up
  // by. (PR #352 Platform review Plat-LOW-2a.)
  // The partial index on `WHERE public = TRUE` is created by migration
  // 0051 and not modelled here (Drizzle does not yet support partial
  // indexes in `pgTable` declarations; the migration is the source of
  // truth for that index).
);

/**
 * Per-tenant overrides on top of the platform default in
 * `feature_flags` (Epic #365 / doc 18 § 4.2). Highest precedence in
 * the evaluator after the `deprecated`/`scope='platform'` hard gates.
 *
 * Tenant-scoped table — RLS forced. `givernance_app` (NOBYPASSRLS)
 * sees only rows where `tenant_id = app_current_organization_id()`.
 * Platform endpoints (super-admin tenant-overrides UI) connect via
 * the owner role and see every row.
 */
export const tenantFlagOverrides = pgTable(
  "tenant_flag_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /**
     * References `feature_flags.key` by VARCHAR rather than by id —
     * keeps the override row referenceable even when migrations
     * renumber the registry. ON DELETE CASCADE means flag retirement
     * (a code change + migration) cleans up every override in one
     * step.
     */
    flagKey: varchar("flag_key", { length: 100 })
      .notNull()
      .references(() => featureFlags.key, { onDelete: "cascade", onUpdate: "cascade" }),
    /** The override value — wins over `feature_flags.enabled` for this tenant. */
    value: boolean("value").notNull(),
    /**
     * Last operator (super-admin OR org-admin) to set / change this
     * override. `SET NULL` on user purge. Audit history lives in
     * `audit_logs` (the audit plugin auto-records every mutating
     * request to /v1/admin/tenants/:id/feature-flags + /v1/org/feature-flags).
     */
    setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * Optional operator-facing free-text. WHY this override exists
     * ("Beta-tested with this NPO on 2026-04 standup", "GDPR
     * compliance request from legal"). Not a structured field —
     * just a note for the audit reader.
     */
    reason: text("reason"),
    /**
     * Reserved for a future auto-expire worker. UI for setting this
     * is deferred per doc 18 § 4.2; the column lands now so the
     * shape doesn't migrate again.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Natural upsert key — one row per (tenant, flag). */
    tenantFlagUnique: unique("tenant_flag_overrides_unique").on(table.tenantId, table.flagKey),
    /** Supports the per-tenant listing in the super-admin + org-admin pages. */
    tenantIdx: index("tenant_flag_overrides_tenant_idx").on(table.tenantId),
    /** Supports `overrideStats` aggregation on /admin/feature-flags. */
    flagIdx: index("tenant_flag_overrides_flag_idx").on(table.flagKey),
  }),
);

// ─── Public Page Status Enum ───────────────────────────────────────────────

export const publicPageStatusEnum = pgEnum("public_page_status", ["draft", "published"]);

// ─── Campaign Public Pages ─────────────────────────────────────────────────

/** Campaign Public Pages — embeddable donation page configuration per campaign */
export const campaignPublicPages = pgTable(
  "campaign_public_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" })
      .unique(),
    status: publicPageStatusEnum("status").notNull().default("draft"),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    colorPrimary: varchar("color_primary", { length: 7 }),
    goalAmountCents: integer("goal_amount_cents"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaign_public_pages_org_id_idx").on(table.orgId),
    index("campaign_public_pages_campaign_id_idx").on(table.campaignId),
  ],
);

// ─── Webhook Events ────────────────────────────────────────────────────────

/** Webhook Events — idempotent tracking of inbound payment gateway webhooks */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeEventId: varchar("stripe_event_id", { length: 255 }).notNull().unique(),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    accountId: varchar("account_id", { length: 255 }),
    payload: jsonb("payload").notNull(),
    status: webhookEventStatusEnum("status").notNull().default("pending"),
    error: text("error"),
    livemode: boolean("livemode").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (table) => [index("webhook_events_stripe_event_id_idx").on(table.stripeEventId)],
);
