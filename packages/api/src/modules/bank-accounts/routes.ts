/**
 * Bank Accounts routes — tenant-scoped CRUD under `requireOrgAdmin`
 * (Epic #318, PR #2).
 *
 * Audit log is captured by the `audit` plugin automatically on every
 * mutating request. The `resource_type=bank-accounts` + `resource_id`
 * pair lands in `audit_logs` per the URL parser in `plugins/audit.ts`.
 */

import {
  BANK_ACCOUNT_CURRENCY_VALUES,
  BANK_ACCOUNT_IBAN_KIND_VALUES,
} from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { requireAuth, requireOrgAdmin } from "../../lib/guards.js";
import {
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  SortOrderSchema,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  BANK_ACCOUNT_SORT_FIELDS,
  BankAccountConflictError,
  BankAccountValidationError,
  createBankAccount,
  deleteBankAccount,
  getBankAccount,
  getBankAccountUsage,
  listBankAccounts,
  updateBankAccount,
} from "./service.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const BankAccountCurrencySchema = Type.Union(
  BANK_ACCOUNT_CURRENCY_VALUES.map((v) => Type.Literal(v)),
);

const BankAccountIbanKindSchema = Type.Union(
  BANK_ACCOUNT_IBAN_KIND_VALUES.map((v) => Type.Literal(v)),
);

const BankAccountResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  holderName: Type.String(),
  /** IG QR-bill v2.4 S-shape: street name (`StrtNm`). */
  holderStreet: Type.String(),
  /** IG QR-bill v2.4 S-shape: building number (`BldgNb`), nullable. */
  holderBuildingNumber: Type.Union([Type.String(), Type.Null()]),
  holderPostalCode: Type.String(),
  /** IG QR-bill v2.4 S-shape: town / city (`TwnNm`). */
  holderTown: Type.String(),
  holderCountryCode: Type.String(),
  iban: Type.String(),
  ibanKind: BankAccountIbanKindSchema,
  bic: Type.Union([Type.String(), Type.Null()]),
  bankName: Type.String(),
  currency: BankAccountCurrencySchema,
  deletedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

// IG QR-bill v2.4 column-width caps mirrored at the API surface so the
// readiness gate doesn't fire on a row the API accepted. See
// `bank_accounts` migration column widths.
const BankAccountCreateBody = Type.Object({
  holderName: Type.String({ minLength: 1, maxLength: 70 }),
  holderStreet: Type.String({ minLength: 1, maxLength: 70 }),
  holderBuildingNumber: Type.Optional(Type.Union([Type.String({ maxLength: 16 }), Type.Null()])),
  holderPostalCode: Type.String({ minLength: 1, maxLength: 16 }),
  holderTown: Type.String({ minLength: 1, maxLength: 35 }),
  holderCountryCode: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
  /** Free-form input — service canonicalises (strips whitespace, uppercases). */
  iban: Type.String({ minLength: 5, maxLength: 42 }),
  bic: Type.Optional(Type.Union([Type.String({ maxLength: 13 }), Type.Null()])),
  bankName: Type.String({ minLength: 1, maxLength: 100 }),
  currency: Type.Optional(BankAccountCurrencySchema),
});

const BankAccountUpdateBody = Type.Object(
  {
    holderName: Type.Optional(Type.String({ minLength: 1, maxLength: 70 })),
    holderStreet: Type.Optional(Type.String({ minLength: 1, maxLength: 70 })),
    holderBuildingNumber: Type.Optional(Type.Union([Type.String({ maxLength: 16 }), Type.Null()])),
    holderPostalCode: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    holderTown: Type.Optional(Type.String({ minLength: 1, maxLength: 35 })),
    holderCountryCode: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
    bic: Type.Optional(Type.Union([Type.String({ maxLength: 13 }), Type.Null()])),
    bankName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    currency: Type.Optional(BankAccountCurrencySchema),
  },
  { minProperties: 1 },
);

const BankAccountSortFieldSchema = Type.Union(BANK_ACCOUNT_SORT_FIELDS.map((f) => Type.Literal(f)));

const BankAccountListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    sort: Type.Optional(BankAccountSortFieldSchema),
    order: Type.Optional(SortOrderSchema),
    includeDeleted: Type.Optional(Type.Boolean()),
  }),
]);

const BankAccountUsageResponse = Type.Object({
  swissQrReferenceCount: Type.Integer({ minimum: 0 }),
  linkedCampaignCount: Type.Integer({ minimum: 0 }),
});

// ─── Routes ────────────────────────────────────────────────────────────────

export async function bankAccountRoutes(app: FastifyInstance) {
  app.get(
    "/bank-accounts",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Bank Accounts"],
        querystring: BankAccountListQuery,
        response: { 200: DataArrayResponse(BankAccountResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      const query = request.query as {
        page?: number;
        perPage?: number;
        sort?: (typeof BANK_ACCOUNT_SORT_FIELDS)[number];
        order?: "asc" | "desc";
        includeDeleted?: boolean;
      };

      const result = await listBankAccounts(orgId, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        sort: query.sort,
        order: query.order,
        includeDeleted: query.includeDeleted ?? false,
      });

      return { data: result.data, pagination: result.pagination };
    },
  );

  app.post(
    "/bank-accounts",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Bank Accounts"],
        body: BankAccountCreateBody,
        response: {
          201: DataResponse(BankAccountResponse),
          400: ProblemDetailSchema,
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      try {
        const account = await createBankAccount(
          orgId,
          request.body as Parameters<typeof createBankAccount>[1],
        );
        return reply.status(201).send({ data: account });
      } catch (err) {
        if (err instanceof BankAccountValidationError) {
          return reply
            .status(400)
            .send(problemDetail(400, "Validation Error", err.message, { field: err.field }));
        }
        if (err instanceof BankAccountConflictError) {
          return reply.status(409).send(problemDetail(409, "Conflict", err.message));
        }
        throw err;
      }
    },
  );

  app.get(
    "/bank-accounts/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Bank Accounts"],
        params: IdParams,
        response: { 200: DataResponse(BankAccountResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const account = await getBankAccount(orgId, id);
      if (!account) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Bank account not found"));
      }
      return { data: account };
    },
  );

  app.get(
    "/bank-accounts/:id/usage",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Bank Accounts"],
        params: IdParams,
        response: { 200: DataResponse(BankAccountUsageResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const account = await getBankAccount(orgId, id, { includeDeleted: true });
      if (!account) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Bank account not found"));
      }
      const usage = await getBankAccountUsage(orgId, id);
      return { data: usage };
    },
  );

  app.patch(
    "/bank-accounts/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Bank Accounts"],
        params: IdParams,
        body: BankAccountUpdateBody,
        response: {
          200: DataResponse(BankAccountResponse),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };

      try {
        const updated = await updateBankAccount(
          orgId,
          id,
          request.body as Parameters<typeof updateBankAccount>[2],
        );
        if (!updated) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Bank account not found"));
        }
        return { data: updated };
      } catch (err) {
        if (err instanceof BankAccountValidationError) {
          return reply
            .status(400)
            .send(problemDetail(400, "Validation Error", err.message, { field: err.field }));
        }
        throw err;
      }
    },
  );

  app.delete(
    "/bank-accounts/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Bank Accounts"],
        params: IdParams,
        response: {
          200: DataResponse(BankAccountResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const deleted = await deleteBankAccount(orgId, id);
      if (!deleted) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Bank account not found"));
      }
      return { data: deleted };
    },
  );
}
