/**
 * Branding / org-logo types — Epic #286.
 *
 * Re-exports the canonical wire shapes from `@givernance/shared/contracts/branding`
 * so the web bundle and the API server share one source of truth for the
 * org-logo endpoints (PR #287 review, blocker 2). The shared module
 * derives its TypeScript types via `Static<typeof BrandingAssetResponseSchema>`,
 * meaning a TypeBox schema change in `packages/shared` immediately flows
 * through to the consumers below — no manual mirroring, no `as` casts.
 *
 * Endpoints (see contract file for full schemas):
 *
 *   GET    /v1/branding/org-logo  → { data: OrgLogo | null }
 *   POST   /v1/branding/org-logo  → { data: OrgLogo }   (status="pending")
 *   DELETE /v1/branding/org-logo  → 200 { data: { deleted: boolean } }
 *
 * The pending → ready transition is observed by polling GET; variants are
 * content-addressed in object storage and served `Cache-Control: immutable`.
 *
 * Subpath import per ADR-013: never import the barrel `@givernance/shared`
 * from the web bundle — it would drag the Drizzle / Postgres surface in.
 */

import type {
  BrandingVariant,
  BrandingVariantSet,
  OrgLogoResponse,
  OrgLogoStatus,
} from "@givernance/shared/contracts/branding";

export type { BrandingVariant, BrandingVariantSet, OrgLogoStatus };

/**
 * Canonical org-logo asset shape returned by `GET /v1/branding/org-logo`.
 *
 * Variants are nested objects (`{ key, url, contentType, width, height }`),
 * not bare URL strings — read with `logo.variants.sidebar?.url`. Always
 * guard the access: `variants` is `null` until the worker pipeline flips
 * the row to `status="ready"`, and individual entries are optional in case
 * a single rendition errored out.
 */
export type OrgLogo = OrgLogoResponse;

/**
 * Result shape returned by `POST /v1/branding/org-logo`. Same wire shape
 * as `OrgLogo` but constrained to the freshly-created `pending` state —
 * variants will be `null` and `error` will be `null` at this point.
 */
export type OrgLogoPending = OrgLogo;
