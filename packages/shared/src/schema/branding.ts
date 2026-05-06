/**
 * Org branding assets — polymorphic table that stores every "brand-like"
 * asset an organisation uploads (logo today, hero image / favicon /
 * letterhead PDF tomorrow). Epic #286.
 *
 * Why a separate table (not extra columns on `tenants`):
 *   - One tenant can hold a small library of branding assets across
 *     surfaces (sidebar logo, donation-page hero, PDF letterhead). Each
 *     has its own variant matrix and async-processing lifecycle.
 *   - Asset rows are append-only-ish (status flips, then soft-delete);
 *     the `tenants` row stays small + cacheable.
 *   - The active pointer lives on `tenants.logo_asset_id` (FK with
 *     ON DELETE SET NULL) — flipping which asset is "live" is a single
 *     UPDATE, no need to mutate any binary on disk.
 *
 * Lifecycle:
 *   1. API handler validates upload, writes original to S3, INSERTs row
 *      with `status='pending'`, enqueues outbox `branding.process_asset`.
 *   2. Worker derives 4 variants (sidebar/preview/public-hero/pdf-
 *      letterhead), uploads them, flips `status='ready'`.
 *   3. Worker enqueues `branding.activate_logo` which sets
 *      `tenants.logo_asset_id` and emits `keycloak.sync_org_logo`.
 *
 * RLS: `tenant_isolation` policy keyed on `org_id` (see migration 0042).
 */

import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// ─── Enums (string unions — declared in migration 0042 as Postgres enums) ──

export const BRANDING_ASSET_TYPE_VALUES = ["org_logo"] as const;
export type BrandingAssetType = (typeof BRANDING_ASSET_TYPE_VALUES)[number];

export const BRANDING_ASSET_STATUS_VALUES = ["pending", "ready", "failed"] as const;
export type BrandingAssetStatus = (typeof BRANDING_ASSET_STATUS_VALUES)[number];

/**
 * Canonical variant keys — one entry per derived rendition the worker
 * produces for an `org_logo` asset. Surfaces consuming each variant:
 *
 *   - `sidebar`        128×128 WebP — left-rail collapsed nav badge.
 *   - `preview`        240×240 WebP — settings page thumbnail / picker card.
 *   - `public-hero`    800×800 WebP — donor-facing hero (donation page,
 *                      Keycloak login template via `logo_url` attribute).
 *   - `pdf-letterhead` 360×360 PNG @ 300 DPI — embedded in postal-letter
 *                      PDFs. PNG (not WebP) because PDFKit's `doc.image`
 *                      only accepts PNG / JPEG. 300 DPI metadata so print
 *                      shops sample at print resolution.
 */
export type BrandingVariantKey = "sidebar" | "preview" | "public-hero" | "pdf-letterhead";

/**
 * Shape of `org_branding_assets.variants` — one entry per derived
 * rendition. `key` is an S3 key (relative to the branding bucket) and
 * `contentType` is the served MIME type. The worker writes this object
 * once it's flipped the row to `status='ready'`. NULL until then.
 */
export interface BrandingAssetVariants {
  sidebar?: { key: string; contentType: string; width: number; height: number };
  preview?: { key: string; contentType: string; width: number; height: number };
  "public-hero"?: { key: string; contentType: string; width: number; height: number };
  "pdf-letterhead"?: { key: string; contentType: string; width: number; height: number };
}

// ─── Table ────────────────────────────────────────────────────────────────

/**
 * Polymorphic branding asset row — see file header for rationale.
 *
 * `assetType` is the discriminator (`org_logo` today; `donation_hero`,
 * `favicon` later). `originalKey` + `originalContentType` describe the
 * raw upload exactly as the operator sent it (sanitised for SVG); the
 * `variants` jsonb carries the worker-derived renditions.
 *
 * Soft-delete via `deletedAt` so audit reconstruction stays possible
 * after the operator removes a logo. Garbage-collection of S3 objects
 * runs on the `branding.gc_asset` worker job.
 */
export const orgBrandingAssets = pgTable(
  "org_branding_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Tenant this asset belongs to. RLS keyed on this column. */
    orgId: uuid("org_id").notNull(),
    /** Discriminator — one of `BRANDING_ASSET_TYPE_VALUES`. Indexed partially. */
    assetType: varchar("asset_type", { length: 32 }).notNull().$type<BrandingAssetType>(),
    /** Lifecycle marker — see `BRANDING_ASSET_STATUS_VALUES`. */
    status: varchar("status", { length: 16 })
      .notNull()
      .default("pending")
      .$type<BrandingAssetStatus>(),
    /** S3 key (in the `branding` bucket) of the original upload. */
    originalKey: varchar("original_key", { length: 500 }).notNull(),
    /** MIME type of the original upload, validated by magic-byte at the API. */
    originalContentType: varchar("original_content_type", { length: 64 }).notNull(),
    /**
     * Original byte size — used by audit + plan-gating reads. INTEGER so
     * future SQL aggregates (`SUM(original_bytes)` per-tenant cap,
     * histogram buckets) work without `::int` casts. Migration 0043
     * converted this from JSONB; see PR #287 review (major 7).
     */
    originalBytes: integer("original_bytes"),
    /**
     * Worker-derived variants. Keyed by `BrandingVariantKey`. NULL until
     * the worker flips status to `ready`. JSONB (not a child table)
     * because the variant set is fixed-shape, never queried in
     * isolation, and changes only when the pipeline schema bumps.
     */
    variants: jsonb("variants").$type<BrandingAssetVariants | null>(),
    /**
     * Source (raster) dimensions captured during validation. INTEGER —
     * see `originalBytes` rationale; migration 0043 converted from
     * JSONB.
     */
    sourceWidth: integer("source_width"),
    sourceHeight: integer("source_height"),
    /** On `status='failed'`, captured error message for the admin UI. */
    error: text("error"),
    /** User who uploaded — soft-link via varchar so KC erasure doesn't break audit. */
    uploadedBy: varchar("uploaded_by", { length: 255 }),
    /** Soft-delete marker — GC job removes S3 prefix when set. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_branding_org_id").on(table.orgId),
    // The partial unique index "one active asset per (org, type)" lives
    // in migration 0042 — Drizzle Kit doesn't model partial indexes so
    // we declare the predicate at SQL level only. Add a non-partial
    // covering index here for type-side parity in query planning.
    index("idx_branding_org_type").on(table.orgId, table.assetType),
  ],
);

export type OrgBrandingAsset = typeof orgBrandingAssets.$inferSelect;
export type NewOrgBrandingAsset = typeof orgBrandingAssets.$inferInsert;
