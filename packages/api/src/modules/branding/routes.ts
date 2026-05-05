/**
 * Branding routes — Epic #286.
 *
 * Operator-facing endpoints for managing the org logo:
 *
 *   - `POST   /v1/branding/org-logo` — multipart upload of a new logo.
 *     Validates magic-bytes, dimensions, sanitises SVG, writes original
 *     to S3, INSERTs the asset row + outbox events for the worker
 *     pipeline + KC sync.
 *   - `GET    /v1/branding/org-logo` — returns the active logo
 *     metadata + variant URLs (or null when no logo is configured).
 *   - `DELETE /v1/branding/org-logo` — soft-deletes the active logo
 *     and enqueues the GC job.
 *
 * Auth: all three are gated by `requireOrgAdmin`. Logo branding is an
 * org-admin-only operation in scope (high-visibility donor-facing
 * artefact, like the postal mailings).
 *
 * Multipart safety:
 *   - `@fastify/multipart` is configured at the server level with
 *     `limits: { fileSize: 5 * 1024 * 1024, files: 1 }` so an oversize
 *     upload is rejected before the body buffer materialises.
 *   - The handler ALSO enforces a 5 MB raster / 1 MB SVG cap by
 *     reading via `file.toBuffer()` which throws on `limit` reached
 *     (defense-in-depth — see issue spec §I).
 */

import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { fileTypeFromBuffer } from "file-type";
import { requireOrgAdmin } from "../../lib/guards.js";
import { brandingPublicUrl, putBrandingObject } from "../../lib/s3.js";
import {
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import { SvgSanitiserError, sanitiseSvg } from "../../lib/svg-sanitiser.js";
import { createPendingAsset, getLatestLogoAsset, softDeleteActiveLogo } from "./service.js";

// ─── Limits + accepted MIMEs ─────────────────────────────────────────────────

const MAX_RASTER_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_SVG_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_DIMENSION = 4096; // 4096×4096 — reject billion-pixel images

const ACCEPTED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]);

// ─── Schemas ────────────────────────────────────────────────────────────────

const BrandingVariantSchema = Type.Object({
  key: Type.String(),
  url: Type.String(),
  contentType: Type.String(),
  width: Type.Integer(),
  height: Type.Integer(),
});

const BrandingAssetResponseSchema = Type.Object({
  id: UuidSchema,
  status: Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("failed")]),
  assetType: Type.String(),
  originalUrl: Type.String(),
  originalContentType: Type.String(),
  variants: Type.Union([
    Type.Null(),
    Type.Object({
      sidebar: Type.Optional(BrandingVariantSchema),
      preview: Type.Optional(BrandingVariantSchema),
      "public-hero": Type.Optional(BrandingVariantSchema),
      "pdf-letterhead": Type.Optional(BrandingVariantSchema),
    }),
  ]),
  error: Type.Union([Type.Null(), Type.String()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const GetBrandingResponseSchema = Type.Object({
  data: Type.Union([Type.Null(), BrandingAssetResponseSchema]),
});

const DeleteResultSchema = Type.Object({
  deleted: Type.Boolean(),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface AssetRowMin {
  id: string;
  status: "pending" | "ready" | "failed";
  assetType: string;
  originalKey: string;
  originalContentType: string;
  variants: import("@givernance/shared/schema").BrandingAssetVariants | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function serialiseAsset(row: AssetRowMin) {
  const variants = row.variants
    ? Object.fromEntries(
        Object.entries(row.variants).map(([key, val]) =>
          val
            ? [
                key,
                {
                  key: val.key,
                  url: brandingPublicUrl(val.key),
                  contentType: val.contentType,
                  width: val.width,
                  height: val.height,
                },
              ]
            : [key, undefined],
        ),
      )
    : null;
  return {
    id: row.id,
    status: row.status,
    assetType: row.assetType,
    originalUrl: brandingPublicUrl(row.originalKey),
    originalContentType: row.originalContentType,
    variants,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

interface DimensionCheck {
  width: number;
  height: number;
}

/**
 * Read raster dimensions without pulling the full sharp pipeline into
 * the request handler. Uses `sharp().metadata()` lazily (sharp is in
 * `packages/api` deps already for the postal-preview path); SVGs are
 * exempted because the dimension cap is irrelevant to vector inputs.
 */
async function readRasterDimensions(buffer: Buffer): Promise<DimensionCheck | null> {
  const sharpModule = await import("sharp");
  const sharp = sharpModule.default;
  const meta = await sharp(buffer, { limitInputPixels: MAX_DIMENSION * MAX_DIMENSION }).metadata();
  if (!meta.width || !meta.height) return null;
  return { width: meta.width, height: meta.height };
}

interface ValidationFailure {
  status: number;
  problem: ReturnType<typeof problemDetail>;
}

interface ValidationSuccess {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";
  toStore: Buffer;
}

type ValidationOutcome =
  | { ok: true; value: ValidationSuccess }
  | { ok: false; failure: ValidationFailure };

function fail(
  status: number,
  title: string,
  detail: string,
  ext?: Record<string, unknown>,
): ValidationFailure {
  return { status, problem: problemDetail(status, title, detail, ext) };
}

/**
 * Magic-byte + format detection. SVG is sniffed by claimed MIME +
 * `<svg` substring because `file-type` doesn't recognise text formats.
 */
function detectMime(
  buffer: Buffer,
  claimedMime: string,
  detectedMime: string | undefined,
): "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml" | null {
  if (claimedMime === "image/svg+xml" && /<svg\b/i.test(buffer.toString("utf8", 0, 1024))) {
    return "image/svg+xml";
  }
  if (detectedMime && ACCEPTED_MIME_TYPES.has(detectedMime)) {
    return detectedMime as "image/png" | "image/jpeg" | "image/webp";
  }
  return null;
}

/**
 * Run all upload validations: magic-byte detection, byte cap, SVG
 * sanitisation, raster dimensions. Returns either a normalised
 * `(mime, toStore)` payload ready for S3 + DB, or a failure with the
 * specific HTTP status + problem detail to send back.
 *
 * Extracted from the route handler to keep its cognitive complexity
 * under Biome's ceiling (the inline version landed at ~37).
 */
async function validateBrandingUpload(
  buffer: Buffer,
  claimedMime: string,
): Promise<ValidationOutcome> {
  // 1. Magic-byte / format check.
  const detected = await fileTypeFromBuffer(buffer);
  const mime = detectMime(buffer, claimedMime, detected?.mime);
  if (!mime) {
    return {
      ok: false,
      failure: fail(
        400,
        "Bad Request",
        "Unsupported image format — accepted: PNG, JPEG, WebP, SVG",
        { detected_mime: detected?.mime ?? null, claimed_mime: claimedMime },
      ),
    };
  }

  // 2. Per-format byte cap.
  const maxBytes = mime === "image/svg+xml" ? MAX_SVG_BYTES : MAX_RASTER_BYTES;
  if (buffer.byteLength > maxBytes) {
    return {
      ok: false,
      failure: fail(
        413,
        "Payload Too Large",
        mime === "image/svg+xml"
          ? "SVG logo exceeds the 1MB limit"
          : "Logo file exceeds the 5MB limit",
      ),
    };
  }

  // 3. SVG sanitisation.
  let toStore = buffer;
  if (mime === "image/svg+xml") {
    try {
      toStore = sanitiseSvg(buffer);
    } catch (err) {
      if (err instanceof SvgSanitiserError) {
        return {
          ok: false,
          failure: fail(400, "Bad Request", "SVG rejected by sanitiser", { reason: err.reason }),
        };
      }
      throw err;
    }
    return { ok: true, value: { mime, toStore } };
  }

  // 4. Raster dimension cap.
  const dim = await readRasterDimensions(toStore);
  if (!dim) {
    return {
      ok: false,
      failure: fail(400, "Bad Request", "Image could not be decoded"),
    };
  }
  if (dim.width > MAX_DIMENSION || dim.height > MAX_DIMENSION) {
    return {
      ok: false,
      failure: fail(
        400,
        "Bad Request",
        `Image dimensions exceed ${MAX_DIMENSION}×${MAX_DIMENSION}`,
        { width: dim.width, height: dim.height },
      ),
    };
  }

  return { ok: true, value: { mime, toStore } };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function brandingRoutes(app: FastifyInstance) {
  /**
   * POST /v1/branding/org-logo — upload a new org logo.
   *
   * Multipart form with a single `file` field. Returns the freshly
   * created asset row in `status='pending'`; the frontend polls
   * `GET /v1/branding/org-logo` to surface the worker-derived variants
   * once the pipeline completes (typically <2s).
   */
  app.post(
    "/branding/org-logo",
    {
      preHandler: requireOrgAdmin,
      // Per-route rate limit so a runaway operator can't wedge the
      // worker queue with a flurry of identical uploads. Tuned loose
      // enough that legitimate "wrong file → re-upload" attempts work.
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["Branding"],
        // Body is multipart — Fastify TypeBox won't validate it; we
        // declare it loosely so the OpenAPI doc surfaces the shape.
        consumes: ["multipart/form-data"],
        response: {
          201: DataResponse(BrandingAssetResponseSchema),
          400: ProblemDetailSchema,
          413: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }

      // ── 1. Pull the multipart file from the request ─────────────────
      // `request.file()` is provided by `@fastify/multipart`; it returns
      // the first file part (we cap `files: 1` at the plugin level so
      // sneaking a second part is rejected before we get here).
      // biome-ignore lint/suspicious/noExplicitAny: @fastify/multipart augments FastifyRequest at runtime
      const reqWithFile = request as any;
      if (typeof reqWithFile.file !== "function") {
        return reply
          .status(400)
          .send(problemDetail(400, "Bad Request", "Endpoint expects a multipart/form-data body"));
      }
      const file = await reqWithFile.file();
      if (!file) {
        return reply
          .status(400)
          .send(problemDetail(400, "Bad Request", "Multipart request missing `file` field"));
      }

      let buffer: Buffer;
      try {
        // `toBuffer()` enforces the multipart plugin's `fileSize` limit
        // and throws `RequestFileTooLargeError` on overflow. We catch
        // that below and return 413.
        buffer = await file.toBuffer();
      } catch (err) {
        const e = err as { code?: string };
        if (e?.code === "FST_REQ_FILE_TOO_LARGE") {
          return reply
            .status(413)
            .send(problemDetail(413, "Payload Too Large", "Logo file exceeds the 5MB limit"));
        }
        request.log.error({ err }, "Branding upload: file read failed");
        return reply.status(400).send(problemDetail(400, "Bad Request", "Failed to read upload"));
      }

      // ── 2. Validate (magic-byte, dimensions, SVG sanitisation) ──────
      const claimedMime = file.mimetype ?? "";
      const validation = await validateBrandingUpload(buffer, claimedMime);
      if (!validation.ok) {
        return reply.status(validation.failure.status).send(validation.failure.problem);
      }
      const { mime, toStore } = validation.value;

      // ── 3. Upload original + create row + enqueue worker events ────
      const assetId = randomUUID();
      const originalKey = `${orgId}/logo/${assetId}/original.${extensionForMime(mime)}`;
      await putBrandingObject(originalKey, toStore, mime);

      const traceparent = request.headers.traceparent as string | undefined;
      const row = await createPendingAsset({
        orgId,
        assetType: "org_logo",
        originalKey,
        originalContentType: mime,
        originalBytes: toStore.byteLength,
        uploadedBy: request.auth?.userId ?? null,
        traceparent,
      });

      request.log.info(
        { assetId: row.id, orgId, mime, bytes: toStore.byteLength },
        "Branding logo uploaded; pipeline enqueued",
      );

      return reply.status(201).send({ data: serialiseAsset(row) });
    },
  );

  /**
   * GET /v1/branding/org-logo — fetch the org's current logo metadata.
   *
   * Returns the most recent (non-soft-deleted) logo asset, regardless
   * of status — so the frontend can poll while the pipeline runs and
   * surface a "processing" UI state. `data` is `null` when no logo
   * has ever been uploaded.
   */
  app.get(
    "/branding/org-logo",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Branding"],
        response: {
          200: GetBrandingResponseSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const row = await getLatestLogoAsset(orgId);
      return reply.send({ data: row ? serialiseAsset(row) : null });
    },
  );

  /**
   * DELETE /v1/branding/org-logo — clear the active logo.
   *
   * Idempotent: returns `{ deleted: false }` when no active logo
   * existed. The actual S3 cleanup + KC attribute reset run async via
   * the `branding.gc_asset` worker job.
   */
  app.delete(
    "/branding/org-logo",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Branding"],
        response: {
          200: DataResponse(DeleteResultSchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const traceparent = request.headers.traceparent as string | undefined;
      const deleted = await softDeleteActiveLogo({ orgId, traceparent });
      return reply.send({ data: { deleted } });
    },
  );
}

// Re-export to avoid unused-import warnings on the FastifyRequest import.
export type _BrandingRequestType = FastifyRequest;
