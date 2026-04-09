/** Zod validation schemas for core entities */

import { z } from "zod";

/** Schema for creating a new constituent */
export const ConstituentCreateSchema = z.object({
  firstName: z.string().min(1).max(255),
  lastName: z.string().min(1).max(255),
  email: z.string().email().max(255).optional(),
  phone: z.string().max(50).optional(),
  type: z.enum(["donor", "volunteer", "member", "beneficiary", "partner"]).default("donor"),
  tags: z.array(z.string()).optional(),
});

/** Schema for updating a constituent (all fields optional) */
export const ConstituentUpdateSchema = ConstituentCreateSchema.partial();

/** Schema for creating a new donation */
export const DonationCreateSchema = z.object({
  constituentId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  currency: z.enum(["EUR", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK"]).default("EUR"),
  campaignId: z.string().uuid().optional(),
  paymentMethod: z.string().max(50).optional(),
  paymentRef: z.string().max(255).optional(),
  donatedAt: z.string().datetime().optional(),
  fiscalYear: z.number().int().optional(),
});

/** Schema for list query parameters */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

/** Inferred types from Zod schemas */
export type ConstituentCreate = z.infer<typeof ConstituentCreateSchema>;
export type ConstituentUpdate = z.infer<typeof ConstituentUpdateSchema>;
export type DonationCreate = z.infer<typeof DonationCreateSchema>;
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
