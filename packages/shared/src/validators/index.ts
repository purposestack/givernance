/** TypeBox validation schemas for core entities */

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isReservedSlug } from "../constants/reserved-slugs";

/**
 * Tenant slug: 2–50 chars, lowercase alnum + single internal dashes, no leading/
 * trailing dash. The regex requires ≥2 characters (minLength is also set on the
 * schema, but encoding the minimum in the pattern itself guarantees strictness
 * regardless of JSON-schema dialect). The column is VARCHAR(100); we cap at 50
 * here to leave headroom for reserved prefixes and subdomain-era migrations.
 */
export const TENANT_SLUG_PATTERN = "^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$";

export const TenantSlugSchema = Type.String({
  minLength: 2,
  maxLength: 50,
  pattern: TENANT_SLUG_PATTERN,
  description:
    "Lowercase alphanumeric + dashes; 2–50 chars; no leading/trailing dash. Rejected if it matches a reserved platform slug.",
});

/**
 * Validate a slug. Returns the canonical (trimmed + lowercased) value on
 * success so callers can write it straight to the DB without re-normalising,
 * avoiding mixed-case drift between `slug` values stored across tenants.
 *
 * On failure, `reason` is one of:
 * - `syntax`   — fails the regex / length constraints
 * - `reserved` — matches a platform-reserved slug (see `reserved-slugs.ts`)
 * - `punycode` — starts with the IDNA punycode prefix `xn--`; disallowed to
 *   prevent homograph confusion in tenant URLs.
 */
export function validateTenantSlug(
  slug: string,
): { ok: true; slug: string } | { ok: false; reason: "syntax" | "reserved" | "punycode" } {
  const normalised = slug.trim().toLowerCase();
  if (!Value.Check(TenantSlugSchema, normalised)) {
    return { ok: false, reason: "syntax" };
  }
  if (normalised.startsWith("xn--")) {
    return { ok: false, reason: "punycode" };
  }
  if (isReservedSlug(normalised)) {
    return { ok: false, reason: "reserved" };
  }
  return { ok: true, slug: normalised };
}

/** Schema for creating a new constituent */
export const ConstituentCreateSchema = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.Optional(Type.String({ format: "email", maxLength: 255 })),
  phone: Type.Optional(Type.String({ maxLength: 50 })),
  type: Type.Union(
    [
      Type.Literal("donor"),
      Type.Literal("volunteer"),
      Type.Literal("member"),
      Type.Literal("beneficiary"),
      Type.Literal("partner"),
    ],
    { default: "donor" },
  ),
  tags: Type.Optional(Type.Array(Type.String())),
});

/**
 * Schema for updating a constituent.
 *
 * Convention: optional fields accept `null` on UPDATE to mean "clear this
 * field to NULL in the DB" (vs `undefined` / omitted = "leave alone"). This
 * lets the form distinguish "user didn't touch the field" from "user
 * intentionally cleared a previously-set value" — e.g. removing a phone
 * number from a constituent. The CREATE schema keeps Optional<String>
 * because there's nothing to clear yet.
 */
export const ConstituentUpdateSchema = Type.Object({
  firstName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  lastName: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  // Null variants FIRST in every nullable Union — see same convention in the
  // API route (`packages/api/src/modules/constituents/routes.ts`): ajv with
  // coerceTypes coerces runtime `null` to `""` if String comes first.
  email: Type.Optional(Type.Union([Type.Null(), Type.String({ format: "email", maxLength: 255 })])),
  phone: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 50 })])),
  type: Type.Optional(
    Type.Union([
      Type.Literal("donor"),
      Type.Literal("volunteer"),
      Type.Literal("member"),
      Type.Literal("beneficiary"),
      Type.Literal("partner"),
    ]),
  ),
  tags: Type.Optional(Type.Array(Type.String())),
});

/** Schema for a fund allocation within a donation */
export const DonationAllocationSchema = Type.Object({
  fundId: Type.String({ format: "uuid" }),
  amountCents: Type.Integer({ exclusiveMinimum: 0 }),
});

export const MULTI_CURRENCY_VALUES = ["EUR", "GBP", "CHF"] as const;
export const MultiCurrencySchema = Type.Union(
  MULTI_CURRENCY_VALUES.map((currency) => Type.Literal(currency)),
  { default: "EUR" },
);

/** Schema for creating a new donation */
export const DonationCreateSchema = Type.Object({
  constituentId: Type.String({ format: "uuid" }),
  amountCents: Type.Integer({ exclusiveMinimum: 0 }),
  currency: Type.Union(
    [
      Type.Literal("EUR"),
      Type.Literal("GBP"),
      Type.Literal("CHF"),
      Type.Literal("SEK"),
      Type.Literal("NOK"),
      Type.Literal("DKK"),
      Type.Literal("PLN"),
      Type.Literal("CZK"),
    ],
    { default: "EUR" },
  ),
  campaignId: Type.Optional(Type.String({ format: "uuid" })),
  paymentMethod: Type.Optional(Type.String({ maxLength: 50 })),
  paymentRef: Type.Optional(Type.String({ maxLength: 255 })),
  donatedAt: Type.Optional(Type.String({ format: "date-time" })),
  fiscalYear: Type.Optional(Type.Integer()),
  allocations: Type.Optional(Type.Array(DonationAllocationSchema)),
});

/** Schema for creating a new campaign */
export const CampaignCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  type: Type.Union([
    Type.Literal("nominative_postal"),
    Type.Literal("door_drop"),
    Type.Literal("digital"),
  ]),
  defaultCurrency: Type.Optional(MultiCurrencySchema),
  parentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  operationalCostCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
});

/** Schema for updating a campaign (all fields optional) */
export const CampaignUpdateSchema = Type.Partial(CampaignCreateSchema);

export const CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES = [
  "#096447",
  "#006C48",
  "#864700",
  "#005138",
  "#3F4943",
] as const;

export type CampaignPublicPageColor = (typeof CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES)[number];

/** Schema for creating or updating a campaign public page */
export const CampaignPublicPageSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 255 }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
  colorPrimary: Type.Optional(
    Type.Union([
      Type.Union(CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES.map((value) => Type.Literal(value))),
      Type.Null(),
    ]),
  ),
  goalAmountCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  status: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("published")])),
});

/** Schema for list query parameters */
export const PaginationQuerySchema = Type.Object({
  page: Type.Number({ minimum: 1, default: 1 }),
  perPage: Type.Number({ minimum: 1, maximum: 100, default: 20 }),
  sort: Type.Optional(Type.String()),
  order: Type.Union([Type.Literal("asc"), Type.Literal("desc")], { default: "desc" }),
});

/** Inferred types from TypeBox schemas */
export type ConstituentCreate = Static<typeof ConstituentCreateSchema>;
export type ConstituentUpdate = Static<typeof ConstituentUpdateSchema>;
export type DonationCreate = Static<typeof DonationCreateSchema>;
export type DonationAllocation = Static<typeof DonationAllocationSchema>;
export type CampaignCreate = Static<typeof CampaignCreateSchema>;
export type CampaignUpdate = Static<typeof CampaignUpdateSchema>;
export type CampaignPublicPage = Static<typeof CampaignPublicPageSchema>;
export type PaginationQuery = Static<typeof PaginationQuerySchema>;

/** Validate, coerce, and apply defaults — throws on failure */
export function parseSchema<T extends TSchema>(schema: T, data: unknown): Static<T> {
  const converted = Value.Default(schema, Value.Convert(schema, structuredClone(data)));
  if (!Value.Check(schema, converted)) {
    const errors = [...Value.Errors(schema, converted)];
    throw new Error(
      `Validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`,
    );
  }
  return converted as Static<T>;
}
