/**
 * Branding API contract — Epic #286.
 *
 * Single source of truth for the wire shape of the org-logo endpoints,
 * shared by the API server (`packages/api`) and the Next.js frontend
 * (`packages/web`). Co-locating the TypeBox schema here closes the
 * drift class flagged in PR #287 review (blocker 2): the web bundle
 * imports the canonical `Static<>` derivation, so a schema change in
 * the API can never silently desync the consumers again.
 *
 * Endpoints:
 *
 *   GET    /v1/branding/org-logo
 *     200 → { data: OrgLogoResponse | null }
 *     401, 403 → RFC 9457 problem
 *
 *   POST   /v1/branding/org-logo  (multipart/form-data)
 *     201 → { data: OrgLogoResponse }   // status="pending" until worker derives variants
 *     400, 413 → RFC 9457 problem
 *
 *   DELETE /v1/branding/org-logo
 *     200 → { data: { deleted: boolean } }
 *     404 → RFC 9457 problem (no active logo)
 *
 * The pending → ready transition is observed by polling GET; variants
 * are content-addressed in object storage and served `Cache-Control:
 * immutable`.
 *
 * The schema lives under `contracts/` (sibling of `validators/`,
 * `events/`, …) so that browser bundles can import it without pulling
 * any Drizzle / Postgres surface from `schema/`. The barrel
 * `@givernance/shared` does NOT re-export from here — consumers import
 * via the subpath `@givernance/shared/contracts/branding` per ADR-013.
 */

import { type Static, Type } from "@sinclair/typebox";

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

/** UUID v4 pattern — same regex used by `packages/api/src/lib/schemas.ts`. */
const UuidSchema = Type.String({ pattern: UUID_PATTERN });

/** Status of an org-logo asset. Mirrors `BRANDING_ASSET_STATUS_VALUES`. */
export const OrgLogoStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);

/** Single derived rendition produced by the worker. */
export const BrandingVariantSchema = Type.Object({
  /** S3 key (relative to the branding bucket). */
  key: Type.String(),
  /** Public URL — already passed through `brandingPublicUrl()` server-side. */
  url: Type.String(),
  /** Served MIME type, e.g. `image/webp` or `image/png`. */
  contentType: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
});

/**
 * Variant set keyed by `BrandingVariantKey`. The worker fills entries
 * incrementally; a freshly-uploaded asset has `variants === null` until
 * the pipeline flips status to `ready`. Each entry is `Optional` so a
 * partial pipeline failure (e.g. `pdf-letterhead` rendition errored)
 * still surfaces the working variants instead of nuking the row.
 */
export const BrandingVariantSetSchema = Type.Object({
  sidebar: Type.Optional(BrandingVariantSchema),
  preview: Type.Optional(BrandingVariantSchema),
  "public-hero": Type.Optional(BrandingVariantSchema),
  "pdf-letterhead": Type.Optional(BrandingVariantSchema),
});

/**
 * Full asset response payload — the wire shape of `data` in
 * `GET / POST /v1/branding/org-logo`. Keep this aligned with
 * `packages/api/src/modules/branding/routes.ts:serialiseAsset`.
 */
export const BrandingAssetResponseSchema = Type.Object({
  id: UuidSchema,
  status: OrgLogoStatusSchema,
  /** Asset-type discriminator — currently always `"org_logo"`. */
  assetType: Type.String(),
  /** Pristine source URL (sanitised SVG / raster as uploaded). */
  originalUrl: Type.String(),
  originalContentType: Type.String(),
  variants: Type.Union([Type.Null(), BrandingVariantSetSchema]),
  /** Populated when `status === "failed"` — surfaces a human-readable cause. */
  error: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/** Response body of `DELETE /v1/branding/org-logo`. */
export const BrandingDeleteResultSchema = Type.Object({
  deleted: Type.Boolean(),
});

/** Wrapped 200/201 envelope used by all three routes. */
export const BrandingGetResponseSchema = Type.Object({
  data: Type.Union([Type.Null(), BrandingAssetResponseSchema]),
});

// ─── Derived TypeScript types ───────────────────────────────────────────────

export type OrgLogoStatus = Static<typeof OrgLogoStatusSchema>;
export type BrandingVariant = Static<typeof BrandingVariantSchema>;
export type BrandingVariantSet = Static<typeof BrandingVariantSetSchema>;

/**
 * Canonical web-side type for an org-logo asset. Replaces the
 * hand-rolled `OrgLogo` interface that drifted from the API shape
 * (PR #287 blocker 2).
 */
export type OrgLogoResponse = Static<typeof BrandingAssetResponseSchema>;

export type BrandingDeleteResult = Static<typeof BrandingDeleteResultSchema>;
