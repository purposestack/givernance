import type { PublicPageStyleKey } from "@givernance/shared/constants";

/**
 * Frontend mirror of `PUBLIC_PAGE_STYLE_REGISTRY` from
 * `@givernance/shared/constants` (Epic #362). The shared file is the
 * single source of truth; this model exists so the web package can
 * consume the registry without importing from `@givernance/shared/schema`
 * (ADR-013 type boundary — `packages/web` MUST NOT import the Drizzle
 * schema). Constants are re-exported directly from the shared
 * `/constants` entry point per the existing ADR-013 carve-out.
 */
export type PublicPageStyle = PublicPageStyleKey;

/**
 * Wire shape for `GET / PATCH /v1/org/style-default` (Epic #362).
 * `null` means "operator hasn't picked an org-level default; the
 * picker should render the inherits-from-Givernance-default state".
 */
export interface TenantStyleDefault {
  defaultPublicPageStyle: PublicPageStyle | null;
}

export interface TenantStyleDefaultResponse {
  data: TenantStyleDefault;
}
