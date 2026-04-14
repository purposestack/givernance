/**
 * Drizzle ORM schema definitions.
 * All tables include org_id for row-level security and audit columns.
 */

import {
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

// ─── Donation-related Enums ──────────────────────────────────────────────────

export const fundTypeEnum = pgEnum("fund_type", ["restricted", "unrestricted"]);

export const pledgeFrequencyEnum = pgEnum("pledge_frequency", ["monthly", "yearly"]);

export const pledgeStatusEnum = pgEnum("pledge_status", ["active", "paused", "cancelled"]);

export const installmentStatusEnum = pgEnum("installment_status", ["pending", "paid", "failed"]);

// ─── Enums ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["org_admin", "user", "viewer"]);

// ─── Tenants (organizations) ──────────────────────────────────────────────────

/** Tenants — registered organizations using Givernance */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  plan: varchar("plan", { length: 50 }).notNull().default("starter"),
  status: varchar("status", { length: 50 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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
