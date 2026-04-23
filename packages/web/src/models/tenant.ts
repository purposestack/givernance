export type TenantCurrency = "EUR" | "GBP" | "CHF";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  baseCurrency: TenantCurrency;
  createdAt: string;
  updatedAt: string;
}

export interface TenantResponse {
  data: Tenant;
}

export interface TenantUpdateInput {
  baseCurrency: TenantCurrency;
}
