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
