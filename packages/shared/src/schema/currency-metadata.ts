import { boolean, integer, pgTable, smallint, text, varchar } from "drizzle-orm/pg-core";

/**
 * Currency metadata — static reference table for ISO 4217 currencies supported
 * by Givernance (ADR-032 §2.9, Epic #416).
 *
 * This is a platform-managed lookup table, not a tenant-scoped one. It has no
 * `org_id` column and no RLS policy — the app role gets SELECT-only access and
 * platform-admin migrations write to it directly.
 *
 * Key columns:
 *   - `code`           ISO 4217 alpha-3 (PK, e.g. "EUR", "CHF")
 *   - `minor_unit`     Exponent (decimal places) per ISO 4217 — 2 for EUR/CHF,
 *                      0 for JPY (zero-decimal), 3 for some Middle-East
 *                      currencies (deferred — none seeded yet).
 *   - `stripe_zero_dec` True when Stripe treats the currency as zero-decimal
 *                      (amount is already in the smallest unit, i.e. *not*
 *                      multiplied by 100). Stripe's list is NOT identical to
 *                      ISO 4217 minor_unit = 0 — use this column for Stripe
 *                      calls, not `minor_unit`.
 *   - `stripe_special`  True when Stripe imposes a non-standard minimum charge
 *                      or a special handling rule (e.g. HUF requires amounts
 *                      in multiples of 100). Consult Stripe docs before
 *                      enabling a flagged currency.
 *   - `stripe_min_amt` Minimum chargeable amount in the currency's smallest
 *                      unit (as returned by Stripe's API docs). Used by the
 *                      checkout-config validator to reject sub-minimum amounts
 *                      before sending to Stripe.
 *   - `enabled`        Platform-wide on/off switch. Only enabled currencies
 *                      appear in the tenant currency picker and the checkout
 *                      flow. Disabled by default; the seed migration enables
 *                      the initial set.
 *
 * TODO(ADR-032): The static MULTI_CURRENCY_VALUES / DonationCreateSchema
 * currency union in `packages/shared/src/validators/index.ts` will be
 * replaced with a runtime check against `currency_metadata.enabled = true`
 * in task #409 (checkout-config endpoint).
 */
export const currencyMetadata = pgTable("currency_metadata", {
  code: varchar("code", { length: 3 }).primaryKey(),
  name: text("name").notNull(),
  minorUnit: smallint("minor_unit").notNull(),
  stripeZeroDec: boolean("stripe_zero_dec").notNull().default(false),
  stripeSpecial: boolean("stripe_special").notNull().default(false),
  stripeMinAmt: integer("stripe_min_amt").notNull(),
  enabled: boolean("enabled").notNull().default(false),
});

export type CurrencyMetadata = typeof currencyMetadata.$inferSelect;
export type NewCurrencyMetadata = typeof currencyMetadata.$inferInsert;
