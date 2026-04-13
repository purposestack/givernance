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
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

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
  (table) => [index("users_org_id_idx").on(table.orgId), index("users_email_idx").on(table.email)],
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
    orgId: uuid("org_id").notNull(),
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
  orgId: uuid("org_id").notNull(),
  firstName: varchar("first_name", { length: 255 }).notNull(),
  lastName: varchar("last_name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  type: varchar("type", { length: 50 }).notNull().default("donor"),
  tags: text("tags").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Donations — financial contributions linked to a constituent */
export const donations = pgTable("donations", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
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
});
