/** TypeBox validation schemas for core entities */

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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

/** Schema for updating a constituent (all fields optional) */
export const ConstituentUpdateSchema = Type.Partial(ConstituentCreateSchema);

/** Schema for a fund allocation within a donation */
export const DonationAllocationSchema = Type.Object({
  fundId: Type.String({ format: "uuid" }),
  amountCents: Type.Integer({ exclusiveMinimum: 0 }),
});

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
  parentId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
  costCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
});

/** Schema for updating a campaign (all fields optional) */
export const CampaignUpdateSchema = Type.Partial(CampaignCreateSchema);

/** Schema for creating or updating a campaign public page */
export const CampaignPublicPageSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 255 }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
  colorPrimary: Type.Optional(
    Type.Union([Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }), Type.Null()]),
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
