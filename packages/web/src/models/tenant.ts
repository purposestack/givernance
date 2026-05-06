import type { Locale } from "@givernance/shared/i18n";
import { MULTI_CURRENCY_VALUES } from "@givernance/shared/validators";

export type TenantCurrency = (typeof MULTI_CURRENCY_VALUES)[number];

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  baseCurrency: TenantCurrency;
  /** BCP-47 default locale for users with `users.locale = NULL` (issue #153). */
  defaultLocale: Locale;
  /**
   * Free-form mission statement (Epic #274 follow-up). Surfaces on
   * postal letters and the future donor-facing footer. NULL until the
   * org_admin fills the org-settings form.
   */
  mission: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantResponse {
  data: Tenant;
}

export interface TenantUpdateInput {
  /** All fields optional — the API accepts a partial update. */
  baseCurrency?: TenantCurrency;
  defaultLocale?: Locale;
  /** `null` clears the mission, `string` sets it, `undefined` leaves alone. */
  mission?: string | null;
}
