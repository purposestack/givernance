import type { Locale } from "@givernance/shared/i18n";

export type TenantCurrency = "EUR" | "GBP" | "CHF";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  baseCurrency: TenantCurrency;
  /** BCP-47 default locale for users with `users.locale = NULL` (issue #153). */
  defaultLocale: Locale;
  createdAt: string;
  updatedAt: string;
}

export interface TenantResponse {
  data: Tenant;
}

export interface TenantUpdateInput {
  /** Either field is optional — the API accepts a partial update. */
  baseCurrency?: TenantCurrency;
  defaultLocale?: Locale;
}
