/**
 * Drizzle ORM schema definitions.
 * All tables include org_id for row-level security and audit columns.
 */

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

export const campaignDocumentStatusEnum = pgEnum("campaign_document_status", [
  "pending",
  "generated",
  "failed",
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
    plan: varchar("plan", { length: 50 }).notNull().default("starter"),
    status: varchar("status", { length: 50 }).notNull().default("active").$type<TenantStatus>(),
    /** How this tenant was provisioned — drives UI affordances, not access. Migration 0021 (ADR-016). */
    createdVia: varchar("created_via", { length: 32 })
      .notNull()
      .default("enterprise")
      .$type<TenantCreatedVia>(),
    /** Email verification timestamp for self-serve signup; NULL until the first admin verifies. */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("users_org_id_idx").on(table.orgId),
    index("users_email_idx").on(table.email),
    unique("users_org_id_email_uniq").on(table.orgId, table.email),
  ],
);

// ─── Invitations ──────────────────────────────────────────────────────────────

/** Purpose discriminator for invitation rows — team invite vs self-serve signup verification (migration 0022). */
export const INVITATION_PURPOSE_VALUES = ["team_invite", "signup_verification"] as const;
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
    purpose: varchar("purpose", { length: 32 })
      .notNull()
      .default("team_invite")
      .$type<InvitationPurpose>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
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
    type: campaignTypeEnum("type").notNull(),
    status: campaignStatusEnum("status").notNull().default("draft"),
    defaultCurrency: varchar("default_currency", { length: 3 }).notNull().default("EUR"),
    parentId: uuid("parent_id").references((): AnyPgColumn => campaigns.id, {
      onDelete: "set null",
    }),
    operationalCostCents: bigint("operational_cost_cents", { mode: "number" }),
    platformFeesCents: bigint("platform_fees_cents", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaigns_org_id_idx").on(table.orgId),
    index("campaigns_org_parent_id_idx").on(table.orgId, table.parentId),
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
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaign_qr_codes_org_id_idx").on(table.orgId),
    index("campaign_qr_codes_campaign_id_idx").on(table.campaignId),
    unique("campaign_qr_codes_org_code_uniq").on(table.orgId, table.code),
  ],
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
