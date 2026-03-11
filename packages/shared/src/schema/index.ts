/**
 * Drizzle ORM schema definitions.
 * All tables include org_id for row-level security and audit columns.
 */

import { pgTable, uuid, varchar, text, timestamp, integer, numeric } from 'drizzle-orm/pg-core'

/** Constituents — donors, volunteers, members, beneficiaries */
export const constituents = pgTable('constituents', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  firstName: varchar('first_name', { length: 255 }).notNull(),
  lastName: varchar('last_name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  type: varchar('type', { length: 50 }).notNull().default('donor'),
  tags: text('tags').array(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Donations — financial contributions linked to a constituent */
export const donations = pgTable('donations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  constituentId: uuid('constituent_id')
    .notNull()
    .references(() => constituents.id),
  amountCents: integer('amount_cents').notNull(),
  currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
  campaignId: uuid('campaign_id'),
  paymentMethod: varchar('payment_method', { length: 50 }),
  paymentRef: varchar('payment_ref', { length: 255 }),
  donatedAt: timestamp('donated_at', { withTimezone: true }).notNull().defaultNow(),
  fiscalYear: integer('fiscal_year'),
  receiptNumber: varchar('receipt_number', { length: 100 }),
  receiptAmount: numeric('receipt_amount', { precision: 12, scale: 2 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
