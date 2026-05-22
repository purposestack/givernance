import type { ApiClient } from "@/lib/api";
import type {
  BankAccount,
  BankAccountCreateInput,
  BankAccountDetailResponse,
  BankAccountListQuery,
  BankAccountListResponse,
  BankAccountUpdateInput,
  BankAccountUsage,
  BankAccountUsageResponse,
} from "@/models/bank-account";

export const BankAccountService = {
  async listBankAccounts(
    client: ApiClient,
    query: BankAccountListQuery = {},
  ): Promise<BankAccountListResponse> {
    const response = await client.get<BankAccountListResponse>("/v1/bank-accounts", {
      params: {
        page: query.page ?? 1,
        perPage: query.perPage ?? 20,
        sort: query.sort,
        order: query.order,
        includeDeleted: query.includeDeleted,
      },
    });

    return {
      data: response.data.map(mapBankAccount),
      pagination: response.pagination,
    };
  },

  async createBankAccount(client: ApiClient, input: BankAccountCreateInput): Promise<BankAccount> {
    const response = await client.post<BankAccountDetailResponse>(
      "/v1/bank-accounts",
      toCreateBody(input),
    );
    return mapBankAccount(response.data);
  },

  async getBankAccount(client: ApiClient, id: string): Promise<BankAccount> {
    const response = await client.get<BankAccountDetailResponse>(
      `/v1/bank-accounts/${encodeURIComponent(id)}`,
    );
    return mapBankAccount(response.data);
  },

  async getBankAccountUsage(client: ApiClient, id: string): Promise<BankAccountUsage> {
    const response = await client.get<BankAccountUsageResponse>(
      `/v1/bank-accounts/${encodeURIComponent(id)}/usage`,
    );
    return response.data;
  },

  async updateBankAccount(
    client: ApiClient,
    id: string,
    input: BankAccountUpdateInput,
  ): Promise<BankAccount> {
    const response = await client.patch<BankAccountDetailResponse>(
      `/v1/bank-accounts/${encodeURIComponent(id)}`,
      toUpdateBody(input),
    );
    return mapBankAccount(response.data);
  },

  async deleteBankAccount(client: ApiClient, id: string): Promise<BankAccount> {
    const response = await client.delete<BankAccountDetailResponse>(
      `/v1/bank-accounts/${encodeURIComponent(id)}`,
    );
    return mapBankAccount(response.data);
  },
};

function mapBankAccount(raw: BankAccount): BankAccount {
  return {
    id: raw.id,
    orgId: raw.orgId,
    label: raw.label,
    holderName: raw.holderName,
    holderStreet: raw.holderStreet,
    holderBuildingNumber: raw.holderBuildingNumber,
    holderPostalCode: raw.holderPostalCode,
    holderTown: raw.holderTown,
    holderCountryCode: raw.holderCountryCode,
    iban: raw.iban,
    ibanKind: raw.ibanKind,
    bic: raw.bic,
    bankName: raw.bankName,
    currency: raw.currency,
    isActive: raw.isActive,
    deletedAt: raw.deletedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function toCreateBody(input: BankAccountCreateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    label: input.label,
    holderName: input.holderName,
    holderStreet: input.holderStreet,
    holderPostalCode: input.holderPostalCode,
    holderTown: input.holderTown,
    iban: input.iban,
    currency: input.currency,
  };
  if (input.holderBuildingNumber !== undefined) {
    body.holderBuildingNumber = input.holderBuildingNumber ?? null;
  }
  if (input.holderCountryCode !== undefined) body.holderCountryCode = input.holderCountryCode;
  if (input.bic !== undefined) body.bic = input.bic ?? null;
  if (input.bankName !== undefined) body.bankName = input.bankName ?? null;
  return body;
}

function toUpdateBody(input: BankAccountUpdateInput): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of [
    "label",
    "holderName",
    "holderStreet",
    "holderPostalCode",
    "holderTown",
    "holderCountryCode",
    "currency",
  ] as const) {
    if (input[key] !== undefined) body[key] = input[key];
  }
  if (input.holderBuildingNumber !== undefined) {
    body.holderBuildingNumber = input.holderBuildingNumber ?? null;
  }
  if (input.bic !== undefined) body.bic = input.bic ?? null;
  if (input.bankName !== undefined) body.bankName = input.bankName ?? null;
  if (input.isActive !== undefined) body.isActive = input.isActive;
  return body;
}
