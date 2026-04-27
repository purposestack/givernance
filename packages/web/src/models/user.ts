import type { Locale } from "@givernance/shared/i18n";

/**
 * Shape of `GET /v1/users/me` (and the PATCH response). The API wraps it
 * in `{ data: ... }` per the rest of the platform.
 *
 * `locale` is the user's personal preference; NULL means "follow the
 * tenant default" (`tenantDefaultLocale`). Issue #153.
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
  locale: Locale | null;
}
