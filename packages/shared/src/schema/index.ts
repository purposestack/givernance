/**
 * Drizzle ORM schema definitions.
 * All tables include org_id for row-level security and audit columns.
 */

import {
  type AnyPgColumn,
  bigint,
  boolean,
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

export const fundTypeEnum = pgEnum("fund_type", ["restricted", "unrestricted"]);

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

// ─── Tenants (organizations) ──────────────────────────────────────────────────

/** Tenants — registered organizations using Givernance */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    plan: varchar("plan", { length: 50 }).notNull().default("starter"),
    status: varchar("status", { length: 50 }).notNull().default("active"),
    stripeAccountId: varchar("stripe_account_id", { length: 255 }),
    country: varchar("country", { length: 2 }),
    legalType: varchar("legal_type", { length: 50 }),
    currency: varchar("currency", { length: 3 }).notNull().default("EUR"),
    registrationNumber: varchar("registration_number", { length: 100 }),
    logoUrl: varchar("logo_url", { length: 500 }),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("tenants_stripe_account_id_uniq").on(table.stripeAccountId)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("users_org_id_idx").on(table.orgId),
    index("users_email_idx").on(table.email),
    unique("users_org_id_email_uniq").on(table.orgId, table.email),
    // Partial UNIQUE (where keycloak_id IS NOT NULL) enforced by migration 0020.
    // Not expressed in Drizzle because pg-core lacks native partial-index syntax;
    // the index is live in the DB and prevents concurrent onboarding bootstrap
    // from creating two users for the same Keycloak subject.
  ],
);

// ─── Invitations ──────────────────────────────────────────────────────────────

/** Invitations — pending email invitations for new users (email sending in Phase 2) */
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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("invitations_org_id_idx").on(table.orgId),
    index("invitations_token_idx").on(table.token),
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
    userId: varchar("user_id", { length: 255 }),
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
  ],
);

// ─── Constituents ─────────────────────────────────────────────────────────────

export { outboxEvents } from "./outbox.js";

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
    campaignId: uuid("campaign_id"),
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
  (table) => [index("funds_org_id_idx").on(table.orgId)],
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pledge_installments_org_id_idx").on(table.orgId),
    index("pledge_installments_pledge_id_idx").on(table.pledgeId),
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
    parentId: uuid("parent_id").references((): AnyPgColumn => campaigns.id, {
      onDelete: "set null",
    }),
    costCents: bigint("cost_cents", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaigns_org_id_idx").on(table.orgId),
    index("campaigns_org_parent_id_idx").on(table.orgId, table.parentId),
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
    code: varchar("code", { length: 255 }).notNull().unique(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("campaign_qr_codes_org_id_idx").on(table.orgId),
    index("campaign_qr_codes_campaign_id_idx").on(table.campaignId),
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
