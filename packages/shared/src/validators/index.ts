/** TypeBox validation schemas for core entities */

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { PUBLIC_PAGE_STYLE_KEYS } from "../constants/public-page-styles";
import { isReservedSlug } from "../constants/reserved-slugs";

export {
  IMPERSONATION_REASON_MAX_LENGTH,
  IMPERSONATION_REASON_MIN_LENGTH,
  type ImpersonationSessionDTO,
  ImpersonationSessionSchema,
  type ImpersonationStartBody,
  ImpersonationStartBodySchema,
  ImpersonationStartResponseSchema,
} from "./impersonation";

// ─── Swiss QR-bill (Epic #318) ──────────────────────────────────────────────

export {
  classifyIban,
  computeQrr,
  computeScor,
  getIbanCountry,
  isQrIban,
  isValidIban,
  isValidQrr,
  isValidScor,
} from "./iban";

export {
  type SwissQrBillCurrency,
  type SwissQrBillPayloadInput,
  type SwissQrBillReferenceType,
  type SwissQrBillValidationError,
  type SwissQrBillValidationResult,
  validateSwissQrBillPayload,
} from "./swiss-qr-bill";

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

/**
 * Postal address (Epic #274 follow-up). All five fields are
 * independent and nullable on the API side — the constituent form
 * lets the operator opt in per recipient. The renderer skips the
 * window-envelope address block when any required line is missing
 * (no `address_line1`, no `postal_code`+`city`, etc.).
 *
 * `country_code` is ISO 3166-1 alpha-2; we validate length but not
 * the alphabet (a typo "FX" still passes — better than rejecting an
 * unfamiliar but valid code we'd missed in an enum).
 */
const PostalAddressSchemaFields = {
  addressLine1: Type.Optional(Type.String({ maxLength: 255 })),
  addressLine2: Type.Optional(Type.String({ maxLength: 255 })),
  postalCode: Type.Optional(Type.String({ maxLength: 20 })),
  city: Type.Optional(Type.String({ maxLength: 255 })),
  countryCode: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
};

const NullablePostalAddressSchemaFields = {
  addressLine1: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 255 })])),
  addressLine2: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 255 })])),
  postalCode: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 20 })])),
  city: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 255 })])),
  countryCode: Type.Optional(
    Type.Union([Type.Null(), Type.String({ minLength: 2, maxLength: 2 })]),
  ),
};

/**
 * Closed picklist of constituent types (issue #465). Single source for both
 * the canonical `types` array and the legacy singular `type` field.
 */
export const ConstituentTypeLiteralUnion = Type.Union([
  Type.Literal("donor"),
  Type.Literal("volunteer"),
  Type.Literal("member"),
  Type.Literal("beneficiary"),
  Type.Literal("partner"),
]);

/** Schema for creating a new constituent */
export const ConstituentCreateSchema = Type.Object({
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.Optional(Type.String({ format: "email", maxLength: 255 })),
  phone: Type.Optional(Type.String({ maxLength: 50 })),
  ...PostalAddressSchemaFields,
  // Canonical multi-valued type (issue #465). At least one, no duplicates.
  // The API rejects >1 element unless the `constituents.multi_type` flag is
  // on for the tenant. Defaults to `["donor"]`.
  types: Type.Optional(
    Type.Array(ConstituentTypeLiteralUnion, { minItems: 1, uniqueItems: true, default: ["donor"] }),
  ),
  // Legacy single-value type. Kept for back-compat (Salesforce ETL, older
  // clients); coerced into `types` server-side when `types` is omitted.
  type: Type.Optional(ConstituentTypeLiteralUnion),
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
  ...NullablePostalAddressSchemaFields,
  // Canonical multi-valued type (issue #465). Omitted = leave alone; when
  // present it must hold ≥1 unique value. The API rejects >1 element unless
  // the `constituents.multi_type` flag is on for the tenant.
  types: Type.Optional(Type.Array(ConstituentTypeLiteralUnion, { minItems: 1, uniqueItems: true })),
  // Legacy single-value type — coerced into `types` server-side when `types`
  // is omitted.
  type: Type.Optional(ConstituentTypeLiteralUnion),
  tags: Type.Optional(Type.Array(Type.String())),
});

/** Schema for a fund allocation within a donation */
export const DonationAllocationSchema = Type.Object({
  fundId: Type.String({ format: "uuid" }),
  amountCents: Type.Integer({ exclusiveMinimum: 0 }),
});

// TODO(ADR-031): Replace this static list with a runtime check against currency_metadata.enabled = true
// This will be wired in task #409 (checkout-config endpoint).
export const MULTI_CURRENCY_VALUES = ["EUR", "GBP", "CHF"] as const;
export const MultiCurrencySchema = Type.Union(
  MULTI_CURRENCY_VALUES.map((currency) => Type.Literal(currency)),
  { default: "EUR" },
);

/** Schema for creating a new donation */
export const DonationCreateSchema = Type.Object({
  constituentId: Type.String({ format: "uuid" }),
  amountCents: Type.Integer({ exclusiveMinimum: 0 }),
  // TODO(ADR-031): Replace this static list with a runtime check against currency_metadata.enabled = true
  // This will be wired in task #409 (checkout-config endpoint).
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

/**
 * Swiss QR-bill campaign reference-mode TypeBox literal (Epic #318).
 * Mirrors the `campaign_qr_reference_mode` Postgres enum declared in
 * `schema/swiss-qr-bill.ts` — the value array there is the single
 * source of truth, and AJV reuses this schema for body validation.
 */
const CampaignQrReferenceModeSchema = Type.Union(
  [Type.Literal("auto"), Type.Literal("qrr"), Type.Literal("scor")],
  { default: "auto" },
);

/** Schema for creating a new campaign */
export const CampaignCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  /**
   * Free-form admin description (Epic #274 follow-up). Soft-cap at
   * 2000 chars matches the postal-letter renderer's expected input.
   * `Type.Null()` first in the union for the same `coerceTypes` AJV
   * pitfall as `operationalCostCents` below.
   */
  description: Type.Optional(Type.Union([Type.Null(), Type.String({ maxLength: 2000 })])),
  type: Type.Union([
    Type.Literal("nominative_postal"),
    Type.Literal("door_drop"),
    Type.Literal("digital"),
  ]),
  defaultCurrency: Type.Optional(MultiCurrencySchema),
  parentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  // Type.Null() comes first in the union: AJV otherwise coerces JSON `null`
  // into 0 when validating the body, which silently turns "clear the value"
  // into "set it to zero" (cf. PR #204 review).
  operationalCostCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
  goalAmountCents: Type.Optional(Type.Union([Type.Null(), Type.Integer({ minimum: 0 })])),
  /**
   * Optional Swiss QR-bill bank-account link (Epic #318). NULL = no
   * QR-bill (standard letter only); set = Swiss QR-bill mode on. The
   * server enforces same-tenant ownership of the FK target before
   * persisting (404 cross-tenant per ADR-019).
   */
  bankAccountId: Type.Optional(Type.Union([Type.Null(), Type.String({ format: "uuid" })])),
  qrReferenceMode: Type.Optional(CampaignQrReferenceModeSchema),
});

/** Schema for updating a campaign (all fields optional) */
export const CampaignUpdateSchema = Type.Partial(CampaignCreateSchema);

export const CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES = [
  "#08675b",
  "#0a6b5e",
  "#864700",
  "#00514a",
  "#3F4943",
] as const;

export type CampaignPublicPageColor = (typeof CAMPAIGN_PUBLIC_PAGE_COLOR_VALUES)[number];

/**
 * Closed enum of public-page archetype identifiers (Epic #362).
 * Kept in lockstep with `PUBLIC_PAGE_STYLE_KEYS` in
 * `@givernance/shared/constants` — the single source of truth — so
 * the validator, the Drizzle enum, the Postgres enum (migration 0054),
 * and the frontend `ARCHETYPES` map all share the same alphabet. Any
 * value outside this set is rejected by the request validator before
 * reaching the service layer.
 *
 * `Type.Unsafe<PublicPageStyleKey>({ type: "string", enum: […] })`:
 * emits a canonical JSON-Schema `enum:` keyword (OpenAPI 3.1 consumers
 * render this as a single enum dropdown rather than 10 separate
 * single-value string types — PR-2 review, API contract N2) while
 * keeping the inferred `Static<>` type narrowed to the literal union
 * — `Type.String({ enum })` widens to `string`, which would defeat
 * compile-time exhaustiveness in the service layer.
 */
export const PublicPageStyleSchema = Type.Unsafe<(typeof PUBLIC_PAGE_STYLE_KEYS)[number]>({
  type: "string",
  enum: [...PUBLIC_PAGE_STYLE_KEYS],
  $id: "PublicPageStyle",
});

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
  /**
   * Per-campaign archetype override (Epic #362). `null` clears the
   * override and falls back to the tenant default (or the platform
   * default). Omitting the field in a PUT body leaves the prior value
   * untouched — distinct from `null`, which explicitly clears it.
   *
   * Behind the `donation.public_page_styles` feature flag: the route
   * gates on `requireFlag(...)` as its FIRST preHandler, so with the
   * flag off the PUT returns 404 and the field can't be set.
   */
  publicPageStyle: Type.Optional(Type.Union([PublicPageStyleSchema, Type.Null()])),
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
export type PublicPageStyle = Static<typeof PublicPageStyleSchema>;

/**
 * Body + response shape for `GET / PATCH /v1/org/style-default`
 * (Epic #362). Single-field schema today; lives next to
 * `PublicPageStyleSchema` so the picker UI gets one named schema in
 * the OpenAPI emit rather than three anonymous inline objects.
 */
export const TenantStyleDefaultSchema = Type.Object({
  defaultPublicPageStyle: Type.Union([PublicPageStyleSchema, Type.Null()]),
});
export type TenantStyleDefault = Static<typeof TenantStyleDefaultSchema>;
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
