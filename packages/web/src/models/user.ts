import type { Locale } from "@givernance/shared/i18n";

/**
 * Shape of `GET /v1/users/me` (and the PATCH response). The API wraps it
 * in `{ data: ... }` per the rest of the platform.
 *
 * `locale` is the user's personal preference; NULL means "follow the
 * tenant default" (`tenantDefaultLocale`). Issue #153.
 *
 * `displayCurrency` is the user's personal display currency preference
 * (ADR-032 §2.8, Epic #416 Task 7); NULL means "use the org's baseCurrency".
 */
export interface MeProfile {
  id: string;
  orgId: string;
  keycloakId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  firstAdmin: boolean;
  provisionalUntil: string | null;
  locale: Locale | null;
  tenantDefaultLocale: Locale;
  /** ISO 4217 code; null means "use org baseCurrency". ADR-032 §2.8. */
  displayCurrency: string | null;
  orgSlug: string;
  orgName: string;
  createdAt: string;
  updatedAt: string;
}

export interface MeResponse {
  data: MeProfile;
}

export interface UpdateMeInput {
  /** `null` clears the override and reverts to inheriting the tenant default. */
  locale?: Locale | null;
  /**
   * ISO 4217 3-letter code for the user's personal display currency.
   * `null` clears the override so amounts display in the org's baseCurrency.
   * Must be an enabled currency in `currency_metadata` — the API returns 422
   * otherwise. ADR-032 §2.8, Epic #416 Task 7.
   */
  displayCurrency?: string | null;
}
