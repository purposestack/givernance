/** Donation routes — list, get, and create donations */

import type { Readable } from "node:stream";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  buildCustomValidator,
  type CustomFieldPatch,
  type CustomFieldValues,
  type CustomValidator,
} from "@givernance/shared/custom-fields";
import {
  createDecryptStream,
  RECEIPT_ENCRYPTION_SCHEME_V1,
  verifyEncryptedStream,
} from "@givernance/shared/lib/receipt-crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolveEnabledCurrency } from "../../lib/currency.js";
import { CustomFieldValidationError, customFieldsProblem } from "../../lib/custom-field-values.js";
import { flagService as defaultFlagService } from "../../lib/flags/flag-service.js";
import { requireAuth, requireOrgAdmin, requireWrite } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import { getReceiptKekProvider } from "../../lib/receipt-kek.js";
import { fetchReceiptObject } from "../../lib/s3.js";
import {
  CurrencySchema,
  DataArrayResponse,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  SortOrderSchema,
  UuidSchema,
} from "../../lib/schemas.js";
import type { FilterQuery } from "../constituents/filters/types.js";
import {
  buildCustomSerializer,
  getActiveDefinitions,
  getProjectableDefinitions,
  getReadableDefinitions,
} from "../customization/lib/value-service.js";
import { getStripe } from "../payments/service.js";
import type { DonationFieldRegistryBundle } from "./filters/field-registry.js";
import { getDonationFieldRegistryBundle } from "./filters/field-registry.js";
import { registerDonationFilterRoutes } from "./filters/filter.routes.js";
import { DonationFilterService } from "./filters/filter.service.js";
import {
  AllocationSumMismatchError,
  CrossTenantReferenceError,
  createDonation,
  DONATION_SORT_FIELDS,
  deleteDonation,
  getDonation,
  getReceiptByDonation,
  listDonations,
  refundDonation,
  updateDonation,
} from "./service.js";

const ReceiptStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("generated"),
  Type.Literal("failed"),
]);

/**
 * Custom-field values on responses (Epic #539). Keys are org-defined so the
 * schema is a Record with a closed VALUE union — the strict-response firewall
 * is the definition-driven serializer in each handler, which only ever emits
 * keys present in the org's active registry (never the whole stored blob).
 */
const CustomValuesResponseSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Array(Type.String())]),
);

/** Merge-patch payload for `custom` — runtime-validated against the org registry. */
const CustomPatchBodySchema = Type.Record(Type.String(), Type.Unknown());

/**
 * Per-request custom-field serializers for donation read models.
 * `own` — the donation's own values (`donations.custom_fields` flag).
 * `donor` — the projected donor values (`constituents.custom_fields` flag,
 * `show_on_related ∧ ¬sensitive`, cap 5). Both recomputed per request —
 * eligibility is never baked into caches or SSR props (Epic #539 anti-goal #9).
 */
async function buildDonationSerializers(
  request: FastifyRequest,
  orgId: string,
  options?: {
    /**
     * Detail read only: archived donation-domain definitions serialize
     * read-only (docs/35 "values retained, read-only on detail +
     * exports"). Projection (`donor`) never includes archived defs.
     */
    includeArchived?: boolean;
  },
) {
  const flags = request.flagService ?? defaultFlagService;
  const [valuesEnabled, projectionEnabled] = await Promise.all([
    flags.isEnabled(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, { orgId }),
    flags.isEnabled(FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS, { orgId }),
  ]);
  const [ownDefs, donorDefs] = await Promise.all([
    valuesEnabled
      ? options?.includeArchived
        ? getReadableDefinitions(orgId, "donation")
        : getActiveDefinitions(orgId, "donation")
      : null,
    projectionEnabled ? getProjectableDefinitions(orgId) : null,
  ]);
  return {
    own: ownDefs ? buildCustomSerializer(ownDefs) : null,
    donor: donorDefs ? buildCustomSerializer(donorDefs) : null,
  };
}

type DonationSerializers = Awaited<ReturnType<typeof buildDonationSerializers>>;

/**
 * Strips the RAW `custom` / `donorCustomRaw` blobs off a service row and
 * re-attaches them serialized when the matching flag is on. Raw blobs must
 * never reach the wire (Epic #539 anti-goal #5).
 */
function shapeDonationCustom<T extends { custom?: unknown; donorCustomRaw?: unknown }>(
  row: T,
  serializers: DonationSerializers,
) {
  const { custom: rawCustom, donorCustomRaw, ...rest } = row;
  return {
    ...rest,
    ...(serializers.own ? { custom: serializers.own(rawCustom) } : {}),
    ...(serializers.donor && donorCustomRaw !== undefined
      ? { donorCustom: serializers.donor(donorCustomRaw) }
      : {}),
  };
}

function customFieldsDisabledProblem() {
  return problemDetail(
    422,
    "custom_fields_disabled",
    "Custom fields on donations are not enabled for your organisation.",
  );
}

const customValidationProblem = customFieldsProblem;

type DonationCustomWrite =
  | {
      ok: true;
      /** Create path only: pre-merged blob (there is no existing row to race). */
      merged: CustomFieldValues | undefined;
      /** Update path only: raw patch + validator — merged INSIDE the update tx. */
      patch: CustomFieldPatch | undefined;
      validator: CustomValidator | null;
      serializer: ((custom: unknown) => CustomFieldValues) | null;
    }
  | { ok: false; kind: "unprocessable"; problem: ReturnType<typeof problemDetail> };

/**
 * Resolves the `custom` merge-patch of a donation write. Flag off + values
 * in the payload → 422 (multi-type precedent, issue #465: the core route
 * always works, the gated affordance is rejected loudly, never silently
 * dropped). Flag on → create path (`donationId` absent) validates + merges
 * here against `{}` with `required` enforced; update path hands the raw
 * patch + validator down to the service, which merges over the FOR
 * UPDATE-locked current blob INSIDE the update transaction — reading the
 * blob here would let concurrent patches drop each other's keys.
 */
async function resolveDonationCustomWrite(
  request: FastifyRequest,
  orgId: string,
  patch: Record<string, unknown> | undefined,
  donationId?: string,
): Promise<DonationCustomWrite> {
  const flags = request.flagService ?? defaultFlagService;
  const enabled = await flags.isEnabled(FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS, { orgId });
  if (!enabled) {
    if (patch && Object.keys(patch).length > 0) {
      return { ok: false, kind: "unprocessable", problem: customFieldsDisabledProblem() };
    }
    return { ok: true, merged: undefined, patch: undefined, validator: null, serializer: null };
  }

  const defs = await getActiveDefinitions(orgId, "donation");
  const serializer = buildCustomSerializer(defs);
  const validator = buildCustomValidator(defs);

  if (donationId !== undefined) {
    return {
      ok: true,
      merged: undefined,
      patch: patch as CustomFieldPatch | undefined,
      validator,
      serializer,
    };
  }

  const result = validator.validatePatch({}, patch ?? {}, { enforceRequired: true });
  if (!result.ok) {
    return { ok: false, kind: "unprocessable", problem: customValidationProblem(result.errors) };
  }
  return { ok: true, merged: result.merged, patch: undefined, validator, serializer };
}

/**
 * Maps the domain errors a donation write can throw onto their RFC 9457
 * responses; returns null for anything the handler should rethrow.
 */
function donationWriteErrorProblem(
  err: unknown,
  t: ReturnType<typeof resolveTranslations>,
): { status: 404 | 422; problem: ReturnType<typeof problemDetail> } | null {
  if (err instanceof AllocationSumMismatchError) {
    return { status: 422, problem: problemDetail(422, "Unprocessable Entity", err.message) };
  }
  // Cross-tenant campaign / fund reference → 404 (not 422) so we don't
  // expose whether the id exists at all. Aligns with forthcoming ADR on
  // cross-tenant FK violation semantics.
  if (err instanceof CrossTenantReferenceError) {
    return {
      status: 404,
      problem: problemDetail(
        404,
        "Not Found",
        t("errors.notFound", {
          resource: err.reference === "campaign" ? t("resources.campaign") : t("resources.fund"),
        }),
      ),
    };
  }
  return null;
}

/**
 * Server-side sort fields whitelist for `GET /donations`. Single source
 * of truth lives in `./service.ts` so the route-level TypeBox literal
 * and the service-level `normalizeDonationSort` fallback can never drift.
 */
const DonationSortFieldSchema = Type.Union(
  DONATION_SORT_FIELDS.map((field) => Type.Literal(field)),
);

const ListQuery = Type.Intersect([
  PaginationQuery,
  Type.Object({
    search: Type.Optional(Type.String({ maxLength: 200 })),
    dateFrom: Type.Optional(Type.String({ format: "date" })),
    dateTo: Type.Optional(Type.String({ format: "date" })),
    amountMin: Type.Optional(Type.Integer({ minimum: 0 })),
    amountMax: Type.Optional(Type.Integer({ minimum: 0 })),
    constituentId: Type.Optional(UuidSchema),
    campaignId: Type.Optional(UuidSchema),
    receiptStatus: Type.Optional(ReceiptStatusSchema),
    sort: Type.Optional(DonationSortFieldSchema),
    order: Type.Optional(SortOrderSchema),
    /**
     * Advanced-filter DSL (flag `donations.advanced_filters`) — a
     * JSON-encoded FilterQuery, shareable via the page URL. With the
     * flag off the param "does not exist": requests carrying it 404.
     */
    filters: Type.Optional(Type.String({ maxLength: 8192 })),
  }),
]);

type DonationFiltersParamResult =
  | { ok: true; filter: FilterQuery | undefined; registryBundle?: DonationFieldRegistryBundle }
  | { ok: false; status: 400 | 404; problem: ReturnType<typeof problemDetail> };

/**
 * `?filters=` DSL handling for the donations list (mirror of the
 * constituents `parseFiltersParam`, Epic #418 / ADR-033 posture). With
 * `donations.advanced_filters` off the param does not exist, so a request
 * carrying it 404s exactly like the gated `/donations/filter/*` routes do
 * (`requireFlag` posture — never silently return an UNFILTERED result an
 * operator believes is filtered, and never disclose the feature to a
 * scanner via a 400/403).
 */
async function parseDonationFiltersParam(
  request: FastifyRequest,
  orgId: string,
  filters: string | undefined,
): Promise<DonationFiltersParamResult> {
  if (filters === undefined) {
    return { ok: true, filter: undefined };
  }

  const flags = request.flagService ?? defaultFlagService;
  const enabled = await flags.isEnabled(FEATURE_FLAG_KEYS.DONATIONS_ADVANCED_FILTERS, { orgId });
  if (!enabled) {
    request.log.info(
      {
        event: "flag.route_gated",
        flagKey: FEATURE_FLAG_KEYS.DONATIONS_ADVANCED_FILTERS,
        path: request.routeOptions.url ?? request.url,
        method: request.method,
      },
      "Donations list filters param gated off — feature flag disabled",
    );
    return { ok: false, status: 404, problem: problemDetail(404, "Not Found", "Route not found") };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(filters);
  } catch {
    return {
      ok: false,
      status: 400,
      problem: problemDetail(
        400,
        "Invalid filter query",
        "The filters parameter is not valid JSON",
      ),
    };
  }

  // `validateQuery` expects an object — reject scalars/null/arrays here
  // so a hand-edited URL can't crash it with a property access on null.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 400,
      problem: problemDetail(
        400,
        "Invalid filter query",
        "The filters parameter must be a JSON object",
      ),
    };
  }

  const registryBundle = await getDonationFieldRegistryBundle(orgId);
  const filterService = new DonationFilterService(orgId, request.log, registryBundle);
  const validation = filterService.validateQuery(parsed as FilterQuery);
  if (!validation.valid) {
    // Archived donation-domain custom field (Epic #539): the persisted
    // `?filters=` link must fail with the NAMED problem — same contract as
    // the constituents list route — never a generic error or a silent drop.
    if (validation.archivedFields.length > 0) {
      return {
        ok: false,
        status: 400,
        problem: problemDetail(
          400,
          "custom_field_archived",
          "The filter references archived custom fields",
          { errors: validation.errors, archived_fields: validation.archivedFields },
        ),
      };
    }
    return {
      ok: false,
      status: 400,
      problem: problemDetail(400, "Invalid filter query", "The filter query contains errors", {
        errors: validation.errors,
      }),
    };
  }

  return { ok: true, filter: parsed as FilterQuery, registryBundle };
}

const AllocationSchema = Type.Object({
  fundId: UuidSchema,
  amountCents: Type.Integer({ minimum: 1 }),
});

/**
 * Currency on WRITE bodies — any ISO-4217 code, case-insensitive (the manual
 * form sends lowercase). Validated against enabled `currency_metadata` in the
 * handler so a manual donation can use ANY Fixer-supported currency, not just a
 * hard-coded European subset (findings #9 + #11). Responses keep the uppercase
 * `CurrencySchema` union. A hard-coded uppercase union here silently dropped a
 * lowercase code, defaulting the row to EUR.
 */
const CurrencyWriteSchema = Type.Optional(Type.String({ minLength: 3, maxLength: 3 }));

const DonationCreateBody = Type.Object({
  constituentId: UuidSchema,
  amountCents: Type.Integer({ minimum: 1 }),
  currency: CurrencyWriteSchema,
  campaignId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  paymentMethod: Type.Optional(Type.String({ maxLength: 50 })),
  paymentRef: Type.Optional(Type.String({ maxLength: 255 })),
  donatedAt: Type.Optional(Type.String({ format: "date-time" })),
  fiscalYear: Type.Optional(Type.Integer()),
  allocations: Type.Optional(Type.Array(AllocationSchema)),
  custom: Type.Optional(CustomPatchBodySchema),
});

const DonationUpdateBody = Type.Object({
  constituentId: UuidSchema,
  amountCents: Type.Integer({ minimum: 1 }),
  currency: CurrencyWriteSchema,
  campaignId: Type.Optional(Type.Union([UuidSchema, Type.Null()])),
  paymentMethod: Type.Optional(Type.Union([Type.String({ maxLength: 50 }), Type.Null()])),
  paymentRef: Type.Optional(Type.Union([Type.String({ maxLength: 255 }), Type.Null()])),
  donatedAt: Type.Optional(Type.String({ format: "date-time" })),
  fiscalYear: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
  allocations: Type.Optional(Type.Array(AllocationSchema)),
  custom: Type.Optional(CustomPatchBodySchema),
});

/**
 * Idempotency-Key header schema.
 *
 * 24h TTL, scoped per-route and per-tenant. A duplicate in-flight request
 * returns 409 + `retry-after`. A completed key replays that response
 * (including `Location` / `ETag` / `Content-Type` / `retry-after` headers)
 * with `idempotency-replayed: true`. Body fingerprint is NOT verified — same
 * key with a different body replays the original response. Non-2xx
 * responses are NOT cached (4xx retries re-run the handler).
 */
const IdempotencyKeyHeader = Type.Object({
  "idempotency-key": Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 255,
      description:
        "Client-supplied idempotency key. Same key within 24h replays the first 2xx response. See plugins/idempotency.ts.",
    }),
  ),
});

/** Donation shape returned by the API */
const DonationResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  constituentId: UuidSchema,
  amountCents: Type.Integer(),
  currency: CurrencySchema,
  campaignId: Type.Union([UuidSchema, Type.Null()]),
  paymentMethod: Type.Union([Type.String(), Type.Null()]),
  paymentRef: Type.Union([Type.String(), Type.Null()]),
  donatedAt: Type.String(),
  fiscalYear: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  /** Present only when `donations.custom_fields` is on; definition-filtered. */
  custom: Type.Optional(CustomValuesResponseSchema),
});

/** Donation list row — enriched with constituent name and latest receipt status for list views */
const DonationListRow = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  constituentId: UuidSchema,
  amountCents: Type.Integer(),
  currency: CurrencySchema,
  campaignId: Type.Union([UuidSchema, Type.Null()]),
  paymentMethod: Type.Union([Type.String(), Type.Null()]),
  paymentRef: Type.Union([Type.String(), Type.Null()]),
  donatedAt: Type.String(),
  fiscalYear: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  constituent: Type.Union([
    Type.Object({ firstName: Type.String(), lastName: Type.String() }),
    Type.Null(),
  ]),
  campaign: Type.Union([Type.Object({ name: Type.String() }), Type.Null()]),
  receiptStatus: Type.Union([
    Type.Literal("pending"),
    Type.Literal("generated"),
    Type.Literal("failed"),
    Type.Null(),
  ]),
  /** Present only when `donations.custom_fields` is on; definition-filtered. */
  custom: Type.Optional(CustomValuesResponseSchema),
  /**
   * Cross-domain projection of the donor's `show_on_related` constituent
   * fields (Epic #539 §6). Present only when `constituents.custom_fields`
   * is on; sensitive/archived defs and erased donors never project.
   */
  donorCustom: Type.Optional(CustomValuesResponseSchema),
});

const DonationStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("cleared"),
  Type.Literal("refunded"),
  Type.Literal("failed"),
]);

const DonationDetailResponse = Type.Object({
  id: UuidSchema,
  orgId: UuidSchema,
  constituentId: UuidSchema,
  amountCents: Type.Integer(),
  currency: CurrencySchema,
  campaignId: Type.Union([UuidSchema, Type.Null()]),
  paymentMethod: Type.Union([Type.String(), Type.Null()]),
  paymentRef: Type.Union([Type.String(), Type.Null()]),
  // Issue #199: exposed so the donation detail UI can hide the refund
  // button on already-refunded rows and the refund flow doesn't surprise
  // a donor who clicked twice.
  status: DonationStatusSchema,
  donatedAt: Type.String(),
  fiscalYear: Type.Union([Type.Integer(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  constituent: Type.Object({
    id: UuidSchema,
    firstName: Type.String(),
    lastName: Type.String(),
    email: Type.Union([Type.String(), Type.Null()]),
  }),
  allocations: Type.Array(
    Type.Object({
      id: UuidSchema,
      fundId: UuidSchema,
      fundName: Type.String(),
      amountCents: Type.Integer(),
    }),
  ),
  /** Present only when `donations.custom_fields` is on; definition-filtered. */
  custom: Type.Optional(CustomValuesResponseSchema),
  /** Donor projection — same contract as the list row (Epic #539 §6). */
  donorCustom: Type.Optional(CustomValuesResponseSchema),
});

/**
 * The receipt metadata response. `downloadPath` is a relative API path
 * the frontend opens directly — `staging.givernance.org/v1/donations/.../
 * receipt/download` — so the donor-visible URL stays on the app's apex
 * (issue #214). No presigned URL field: presigned URLs would point at
 * the internal Docker hostname `givernance-seaweedfs:8333`, unreachable from
 * the browser.
 *
 * `expiresAt` is a coarse "consider re-fetching after" hint — the path
 * itself is timeless (re-authenticated on every download). We
 * deliberately do NOT surface the JWT `exp` here: leaking the precise
 * token-rotation instant would give an attacker who exfiltrates the
 * cookie a useful timing primitive (review feedback). A fixed +1h
 * horizon, rounded to the minute, is enough for a client that wants to
 * pre-refresh and reveals nothing about the session.
 */
const ReceiptDownloadResponse = Type.Object({
  downloadPath: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
});

const RECEIPT_METADATA_TTL_SECONDS = 3600;

/** Strict allowlist for receipt numbers we'll trust in a Content-Disposition
 * filename. Today's generator emits `REC-YYYY-NNNN`; this regex pins that
 * shape so a future writer (Salesforce import, manual SQL, schema drift)
 * can never inject a `"` or CRLF that would split / corrupt the response
 * header. Unmatched values get a generic `receipt.pdf` filename — the
 * download still works, the legal artifact still ships, the header just
 * stops carrying user-controlled bytes. */
const SAFE_RECEIPT_NUMBER_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Decryption material for one envelope-encrypted receipt (issue #228). */
interface ReceiptDecryptMaterial {
  dek: Buffer;
  iv: Buffer;
  authTag: Buffer;
  /**
   * GCM associated data — the authenticated tenant's orgId. Binds the
   * ciphertext to its tenant: a crypto tuple transplanted onto another
   * org's row fails tag verification (D1 hardening).
   */
  aad: Buffer;
  /**
   * Exact plaintext byte count observed by the integrity verification
   * pass — exact by construction, so it (not the DB's advisory
   * `plaintext_length` column) is what Content-Length is built from.
   */
  verifiedPlaintextLength: number;
}

type ReceiptDecryptResolution =
  | { ok: true; decrypt: ReceiptDecryptMaterial | null }
  | { ok: false };

/**
 * Resolve — and integrity-verify — the decryption material for a receipt
 * row (issue #228). Returns `{ ok: true, decrypt: null }` for legacy
 * (scheme NULL) rows, the verified material for envelope-encrypted rows,
 * and `{ ok: false }` (after logging) for every failure mode: unknown
 * scheme (forward-compat — a NEWER deploy wrote it; 502 is retryable
 * once the fleet converges), missing crypto fields, KEK unwrap failure,
 * and GCM integrity failure. Fail-closed: the caller must 502, never
 * fall through to streaming raw ciphertext.
 *
 * Why a pre-verification pass: GCM only verifies its auth tag at stream
 * finalisation — AFTER every plaintext chunk has already been emitted —
 * so a single-pass pipe-to-response would flush a 200 + tampered-origin
 * bytes before discovering the corruption. Instead the ciphertext is
 * streamed through a throwaway decipher (memory-bounded, output
 * discarded) before the serving pass. Costs one extra S3 GET on
 * encrypted receipts (tens of KB) in exchange for a genuinely
 * fail-closed 502 on tampering.
 *
 * Log lines carry reason strings only — NEVER key material (dek /
 * dekWrapped / keyring are also pino-redacted as a second wall).
 */
async function resolveReceiptDecryption(
  request: FastifyRequest,
  orgId: string,
  receipt: {
    id: string;
    s3Path: string;
    encryptionScheme: string | null;
    dekWrapped: string | null;
    kekVersionId: string | null;
    encryptionIv: string | null;
    encryptionAuthTag: string | null;
  },
): Promise<ReceiptDecryptResolution> {
  const scheme = receipt.encryptionScheme;
  if (scheme === null) {
    return { ok: true, decrypt: null };
  }
  if (scheme !== RECEIPT_ENCRYPTION_SCHEME_V1) {
    request.log.error(
      { receiptId: receipt.id, encryptionScheme: scheme, reason: "unknown_encryption_scheme" },
      "Receipt decryption failed",
    );
    return { ok: false };
  }

  // AAD = the AUTHENTICATED tenant's orgId (from the JWT context that
  // scoped `getReceiptByDonation`), never a client-supplied value — this
  // is what makes the cross-org transplant binding trustworthy (D1).
  const aad = Buffer.from(orgId);

  let dek: Buffer;
  let iv: Buffer;
  let authTag: Buffer;
  try {
    if (
      !receipt.dekWrapped ||
      !receipt.kekVersionId ||
      !receipt.encryptionIv ||
      !receipt.encryptionAuthTag
    ) {
      // The DB CHECK constraint makes this unreachable; belt-and-suspenders.
      throw new Error("encrypted receipt row is missing crypto fields");
    }
    const kekProvider = getReceiptKekProvider();
    dek = await kekProvider.unwrap(receipt.dekWrapped, receipt.kekVersionId);
    iv = Buffer.from(receipt.encryptionIv, "base64");
    authTag = Buffer.from(receipt.encryptionAuthTag, "base64");
  } catch (err) {
    request.log.error(
      {
        receiptId: receipt.id,
        kekVersionId: receipt.kekVersionId,
        reason: err instanceof Error ? err.message : String(err),
      },
      "Receipt DEK unwrap failed",
    );
    return { ok: false };
  }

  let verifyBody: Awaited<ReturnType<typeof fetchReceiptObject>>["body"] | undefined;
  let verifiedPlaintextLength: number;
  try {
    ({ body: verifyBody } = await fetchReceiptObject(receipt.s3Path));
    verifiedPlaintextLength = await verifyEncryptedStream(dek, iv, authTag, aad, verifyBody);
  } catch (err) {
    // If the failure was SYNCHRONOUS (e.g. a malformed IV/tag length in
    // the DB row throws before the pipe starts), the S3 stream was never
    // consumed — destroy it so the SDK socket is reclaimed instead of
    // leaking until its idle timeout (review M3). Best-effort: the
    // stream may already be consumed/destroyed on async failures.
    try {
      verifyBody?.destroy();
    } catch {
      // ignore — cleanup only
    }
    request.log.error(
      {
        receiptId: receipt.id,
        kekVersionId: receipt.kekVersionId,
        reason: err instanceof Error ? err.message : String(err),
      },
      "Receipt ciphertext integrity verification failed",
    );
    return { ok: false };
  }

  return { ok: true, decrypt: { dek, iv, authTag, aad, verifiedPlaintextLength } };
}

/**
 * Wire the receipt response stream (issue #228): the raw S3 body for
 * legacy rows, or `body → decipher` for envelope-encrypted rows. The
 * decipher's own error listener covers "object changed between the
 * verification pass and this streaming pass" (near-impossible, but at
 * that point headers are flushed — all we can do is destroy).
 */
function buildReceiptResponseStream(
  request: FastifyRequest,
  body: Awaited<ReturnType<typeof fetchReceiptObject>>["body"],
  decrypt: ReceiptDecryptMaterial | null,
  ctx: { donationId: string; receiptId: string },
): NodeJS.ReadableStream {
  if (!decrypt) return body;
  const decipher = createDecryptStream(decrypt.dek, decrypt.iv, decrypt.authTag, decrypt.aad);
  decipher.on("error", (streamErr) => {
    request.log.error(
      { err: streamErr, donationId: ctx.donationId, receiptId: ctx.receiptId },
      "Receipt decipher stream error after headers flushed",
    );
    body.destroy();
    decipher.destroy();
  });
  return body.pipe(decipher);
}

/**
 * Content-Length for the receipt download (issue #228). For envelope-
 * encrypted rows the S3 ContentLength is the CIPHERTEXT size — the
 * client receives plaintext, so the header comes from the byte count
 * the integrity verification pass just measured (exact by
 * construction, review L4; the DB's `plaintext_length` column stays as
 * advisory metadata and covers rows a legacy writer left NULL). Legacy
 * rows keep the S3 value.
 */
function resolveReceiptContentLength(
  decrypt: ReceiptDecryptMaterial | null,
  s3ContentLength: number | undefined,
): string | null {
  if (decrypt) {
    return decrypt.verifiedPlaintextLength.toString();
  }
  return s3ContentLength !== undefined ? s3ContentLength.toString() : null;
}

export async function donationRoutes(app: FastifyInstance) {
  /** List donations with pagination and filters */
  app.get(
    "/donations",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        querystring: ListQuery,
        response: { 200: DataArrayResponse(DonationListRow), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        const t = resolveTranslations(request);
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const query = request.query as {
        page?: number;
        perPage?: number;
        search?: string;
        dateFrom?: string;
        dateTo?: string;
        amountMin?: number;
        amountMax?: number;
        constituentId?: string;
        campaignId?: string;
        receiptStatus?: "pending" | "generated" | "failed";
        sort?: (typeof DONATION_SORT_FIELDS)[number];
        order?: "asc" | "desc";
        filters?: string;
      };

      const filtersResult = await parseDonationFiltersParam(request, orgId, query.filters);
      if (!filtersResult.ok) {
        return reply.status(filtersResult.status).send(filtersResult.problem);
      }

      // Serializers are built ONCE per request (definitions are one cached
      // catalog read, not per-row lookups) and applied over the join the
      // list already does — no N+1.
      const [result, serializers] = await Promise.all([
        listDonations(orgId, {
          page: query.page ?? 1,
          perPage: query.perPage ?? 20,
          search: query.search,
          dateFrom: query.dateFrom,
          dateTo: query.dateTo,
          amountMin: query.amountMin,
          amountMax: query.amountMax,
          constituentId: query.constituentId,
          campaignId: query.campaignId,
          receiptStatus: query.receiptStatus,
          sort: query.sort,
          order: query.order,
          advancedFilter: filtersResult.filter,
          registryBundle: filtersResult.registryBundle,
        }),
        buildDonationSerializers(request, orgId),
      ]);

      return {
        data: result.data.map((row) => shapeDonationCustom(row, serializers)),
        pagination: result.pagination,
      };
    },
  );

  /** Get a single donation with constituent and allocations */
  app.get(
    "/donations/:id",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        response: { 200: DataResponse(DonationDetailResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };
      const [donation, serializers] = await Promise.all([
        getDonation(orgId, id),
        buildDonationSerializers(request, orgId, { includeArchived: true }),
      ]);

      if (!donation) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.donation") }),
            ),
          );
      }

      return { data: shapeDonationCustom(donation, serializers) };
    },
  );

  /** Record a manual donation (check, cash, wire) */
  app.post(
    "/donations",
    {
      // Issue #181: `minRole` mirrors the route's RBAC guard so the
      // idempotency replay path doesn't short-circuit `requireWrite`.
      config: { idempotency: { routeKey: "POST:/v1/donations", minRole: "write" } },
      preHandler: requireWrite,
      schema: {
        tags: ["Donations"],
        body: DonationCreateBody,
        headers: IdempotencyKeyHeader,
        response: {
          201: DataResponse(DonationResponse),
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const body = request.body as {
        constituentId: string;
        amountCents: number;
        currency?: string;
        campaignId?: string;
        paymentMethod?: string;
        paymentRef?: string;
        donatedAt?: string;
        fiscalYear?: number;
        allocations?: { fundId: string; amountCents: number }[];
        custom?: Record<string, unknown>;
      };

      const customWrite = await resolveDonationCustomWrite(request, orgId, body.custom);
      if (!customWrite.ok) {
        return reply.status(422).send(customWrite.problem);
      }

      // Normalise + validate the currency against enabled currency_metadata
      // (findings #9 + #11) — the manual form sends a lowercase code, which the
      // old uppercase-union schema silently dropped, defaulting the row to EUR.
      if (body.currency !== undefined) {
        const resolved = await resolveEnabledCurrency(body.currency);
        if (!resolved) {
          return reply
            .status(422)
            .send(problemDetail(422, "invalid_currency", "This currency is not supported."));
        }
        body.currency = resolved;
      }

      try {
        const donation = await createDonation(
          orgId,
          userId,
          {
            ...body,
            custom: customWrite.merged,
          },
          request,
        );

        if (!donation) {
          return reply.status(404).send({
            type: "https://httpproblems.com/http-status/404",
            title: "Not Found",
            status: 404,
            detail: t("errors.notFound", { resource: t("resources.constituent") }),
          });
        }

        reply.header("Location", `/v1/donations/${donation.id}`);
        return reply.status(201).send({
          data: shapeDonationCustom(donation, { own: customWrite.serializer, donor: null }),
        });
      } catch (err) {
        const mapped = donationWriteErrorProblem(err, t);
        if (mapped) {
          return reply.status(mapped.status).send(mapped.problem);
        }
        throw err;
      }
    },
  );

  app.patch(
    "/donations/:id",
    {
      preHandler: requireWrite,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        body: DonationUpdateBody,
        response: {
          200: DataResponse(DonationResponse),
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };
      const body = request.body as {
        constituentId: string;
        amountCents: number;
        currency?: string;
        campaignId?: string | null;
        paymentMethod?: string | null;
        paymentRef?: string | null;
        donatedAt?: string;
        fiscalYear?: number | null;
        allocations?: { fundId: string; amountCents: number }[];
        custom?: Record<string, unknown>;
      };

      const customWrite = await resolveDonationCustomWrite(request, orgId, body.custom, id);
      if (!customWrite.ok) {
        return reply.status(422).send(customWrite.problem);
      }

      // Same currency normalisation + enabled-validation as create (findings #9 / #11).
      if (body.currency !== undefined) {
        const resolved = await resolveEnabledCurrency(body.currency);
        if (!resolved) {
          return reply
            .status(422)
            .send(problemDetail(422, "invalid_currency", "This currency is not supported."));
        }
        body.currency = resolved;
      }

      try {
        // The service validates + merges the patch over the FOR UPDATE-locked
        // current blob inside its transaction (concurrent-patch safety).
        const updated = await updateDonation(orgId, id, {
          ...body,
          custom: customWrite.patch,
          customValidator: customWrite.validator,
        });

        if (!updated) {
          return reply.status(404).send({
            type: "https://httpproblems.com/http-status/404",
            title: "Not Found",
            status: 404,
            detail: t("errors.notFound", { resource: t("resources.donation") }),
          });
        }

        return { data: shapeDonationCustom(updated, { own: customWrite.serializer, donor: null }) };
      } catch (err) {
        if (err instanceof CustomFieldValidationError) {
          return reply.status(422).send(customValidationProblem(err.errors));
        }
        if (err instanceof AllocationSumMismatchError) {
          return reply.status(422).send({
            type: "https://httpproblems.com/http-status/422",
            title: "Unprocessable Entity",
            status: 422,
            detail: err.message,
          });
        }
        throw err;
      }
    },
  );

  app.delete(
    "/donations/:id",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        response: { 200: DataResponse(DonationResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };
      const [deleted, serializers] = await Promise.all([
        deleteDonation(orgId, id),
        buildDonationSerializers(request, orgId),
      ]);

      if (!deleted) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.donation") }),
            ),
          );
      }

      return { data: shapeDonationCustom(deleted, { own: serializers.own, donor: null }) };
    },
  );

  /**
   * Refund a Stripe donation (issue #199). Only org_admins, only Stripe-
   * sourced donations, and only ones not already refunded.
   *
   * The actual donation-row update happens twice for idempotency: once
   * synchronously here for snappy UI, and again on the `charge.refunded`
   * webhook (which the worker handles regardless of refund origin — our
   * UI or the NPO's Stripe dashboard). Both paths set `status =
   * "refunded"`; the second one is a no-op when it sees the row is
   * already refunded.
   */
  app.post(
    "/donations/:id/refund",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        response: {
          200: DataResponse(Type.Object({ id: UuidSchema, status: Type.Literal("refunded") })),
          422: ProblemDetailSchema,
          502: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };
      const stripe = getStripe();
      const result = await refundDonation(orgId, id, stripe.refunds, request);

      switch (result.kind) {
        case "ok":
          return { data: { id, status: "refunded" as const } };
        case "not_found":
          return reply
            .status(404)
            .send(
              problemDetail(
                404,
                "Not Found",
                t("errors.notFound", { resource: t("resources.donation") }),
              ),
            );
        case "already_refunded":
          return reply
            .status(422)
            .send(problemDetail(422, "Unprocessable Entity", "Donation already refunded"));
        case "not_stripe":
          return reply
            .status(422)
            .send(
              problemDetail(
                422,
                "Unprocessable Entity",
                "Only Stripe-sourced donations can be refunded through this endpoint",
              ),
            );
        case "stripe_error":
          // Sanitised log; donor-/operator-facing message stays generic
          // (memory: don't leak Stripe internals to authenticated callers).
          request.log.error({ errMessage: result.message, donationId: id }, "Stripe refund failed");
          return reply
            .status(502)
            .send(problemDetail(502, "Bad Gateway", "Payment provider error, please try again"));
      }
    },
  );

  /**
   * Receipt metadata — returns the relative `downloadPath` the frontend
   * opens to actually fetch the PDF. The frontend can decide whether to
   * `window.open(downloadPath)` immediately or render a link for later.
   *
   * Pre-issue-#214 this returned a presigned MinIO URL. That broke on
   * staging because the URL contained the internal Docker hostname
   * (`givernance-minio:9000`, baked into the SigV4 signature so it can't
   * be host-rewritten). The new endpoint streams through `:id/receipt/
   * download` instead, keeping every donor-visible URL on the app's apex
   * — see the URL-consistency rule in CLAUDE.md.
   */
  app.get(
    "/donations/:id/receipt",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Donations"],
        params: IdParams,
        response: { 200: DataResponse(ReceiptDownloadResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };

      // Verify donation belongs to this org before exposing receipt
      const donation = await getDonation(orgId, id);
      if (!donation) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.donation") }),
            ),
          );
      }

      const receipt = await getReceiptByDonation(orgId, id);

      if (!receipt) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.receipt") }),
            ),
          );
      }

      // Coarse "consider re-fetching after" hint — fixed +1h, rounded
      // to the minute. Keeps the contract shape (`{ downloadPath,
      // expiresAt }`) but deliberately doesn't surface the JWT exp:
      // leaking the precise token-rotation instant would give an
      // attacker who exfiltrated the cookie a useful timing primitive
      // (review feedback). The path itself is timeless because the
      // download endpoint re-authenticates on every call.
      const horizonMs = Date.now() + RECEIPT_METADATA_TTL_SECONDS * 1000;
      const expiresAt = new Date(horizonMs - (horizonMs % 60_000)).toISOString();
      return {
        data: {
          downloadPath: `/v1/donations/${id}/receipt/download`,
          expiresAt,
        },
      };
    },
  );

  /**
   * Stream a donation's receipt PDF inline from MinIO/S3 (issue #214).
   *
   * Auth + tenant scope are enforced on every call (not just at link
   * generation, the way presigned URLs were), so revoking access is
   * immediate. Each call lands a structured log line via the existing
   * pino instance — `userId` + `donationId` + `receiptNumber` so log-side
   * audit can answer "who downloaded what when" without the scattered S3
   * access logs the presigned-URL flow produced.
   *
   * Cache-Control is `private, no-store` because the response includes a
   * legal proof of donation specific to one user; we don't want a shared
   * cache returning the same PDF to a different identity.
   */
  app.get(
    "/donations/:id/receipt/download",
    {
      preHandler: requireAuth,
      // Per-user rate limit. Without this, a logged-in user (or a
      // compromised session) can loop the download to tie up an API
      // worker and exhaust the container's bandwidth — the API is in
      // the streaming path now (review feedback). 60/min is generous
      // for legitimate "open the same receipt twice in a settings
      // page" usage but caps abuse at ~1/sec. Keyed by orgId+userId so
      // one tenant can't degrade another's downloads.
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          keyGenerator: (req) => {
            const orgId = req.auth?.orgId ?? "no-org";
            const userId = req.auth?.userId ?? req.ip;
            return `receipt-download:${orgId}:${userId}`;
          },
        },
      },
      schema: {
        tags: ["Donations"],
        params: IdParams,
        // Binary streaming response — no JSON envelope; the success
        // path is annotated only via `produces` so OpenAPI consumers
        // know to expect application/pdf (review feedback). Fastify
        // still validates the params at the schema layer above. 502 is
        // for the "MinIO object missing / unreachable" path (see the
        // try/catch around fetchReceiptObject below); 429 is the rate
        // limiter's response shape.
        produces: ["application/pdf"],
        response: { ...ErrorResponses, 429: ProblemDetailSchema, 502: ProblemDetailSchema },
      },
    },
    async (request, reply) => {
      const t = resolveTranslations(request);
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", t("errors.unauthorized")));
      }

      const { id } = request.params as { id: string };

      const donation = await getDonation(orgId, id);
      if (!donation) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.donation") }),
            ),
          );
      }

      const receipt = await getReceiptByDonation(orgId, id);
      if (!receipt) {
        return reply
          .status(404)
          .send(
            problemDetail(
              404,
              "Not Found",
              t("errors.notFound", { resource: t("resources.receipt") }),
            ),
          );
      }

      // ── Envelope-encryption decision (issue #228) ──────────────────────
      // NOT flag-gated: the flag only gates NEW encryption at generation
      // time. Here the row itself says whether the object is ciphertext —
      // an encrypted receipt must stay downloadable even if the flag is
      // later turned off. The helper fails CLOSED on anything unexpected
      // (unknown scheme, unresolvable KEK, failed integrity check) — raw
      // ciphertext must NEVER stream to the client as a "fallback".
      const resolution = await resolveReceiptDecryption(request, orgId, receipt);
      if (!resolution.ok) {
        return reply
          .status(502)
          .send(problemDetail(502, "Bad Gateway", "Receipt is temporarily unavailable"));
      }
      const decrypt = resolution.decrypt;

      // Fetch from MinIO/S3. A receipt row pointing at a missing object
      // (volume reset on staging, partial worker run, manual delete) is
      // genuinely common — surface it as a clean 502 with a generic
      // message instead of letting the AWS SDK's `NoSuchKey` error class
      // bubble up to the global handler and leak the bucket key path
      // into the user-facing problem-detail title.
      let body: Awaited<ReturnType<typeof fetchReceiptObject>>["body"];
      let contentLength: number | undefined;
      try {
        ({ body, contentLength } = await fetchReceiptObject(receipt.s3Path));
      } catch (err) {
        request.log.error(
          {
            err,
            donationId: id,
            receiptId: receipt.id,
            receiptNumber: receipt.receiptNumber,
            s3Path: receipt.s3Path,
          },
          "Receipt object fetch failed",
        );
        return reply
          .status(502)
          .send(problemDetail(502, "Bad Gateway", "Receipt is temporarily unavailable"));
      }

      // Decrypt in-flight for envelope-encrypted receipts (integrity was
      // pre-verified above; this second pass streams). If the object
      // somehow changed between the two passes, the decipher errors after
      // headers — handled by the stream error listener inside the helper,
      // same posture as a transient S3 read error on the legacy path.
      const responseStream = buildReceiptResponseStream(request, body, decrypt, {
        donationId: id,
        receiptId: receipt.id,
      });

      // Detach + destroy the S3 stream if the client disconnects
      // mid-transfer (closed tab, slow network) so the AWS SDK's HTTP
      // agent reclaims the connection instead of holding the socket
      // open until its idle timeout. Same listener handles a transient
      // S3 read error after headers are flushed — at that point we can't
      // change the status code, but we can stop emitting and free the
      // socket.
      request.raw.on("close", () => {
        if (!request.raw.complete) body.destroy();
      });
      body.on("error", (streamErr) => {
        request.log.error(
          { err: streamErr, donationId: id, receiptId: receipt.id },
          "Receipt stream error after headers flushed",
        );
        body.destroy();
        // H1: on the envelope path the CLIENT-facing stream is the
        // decipher (`body.pipe(decipher)`), and `pipe` does NOT forward
        // source errors — destroying only `body` would leave the
        // decipher un-ended and the reply hanging until the client
        // times out. Destroy the response stream too (with the error so
        // Fastify tears the socket down). On the legacy path
        // `responseStream === body`, already destroyed above.
        if (responseStream !== body) {
          (responseStream as Readable).destroy(
            streamErr instanceof Error ? streamErr : new Error(String(streamErr)),
          );
        }
      });

      // Audit log — single source of truth for "who downloaded this
      // receipt". Indexed in Loki via the existing pino → stdout path
      // (docs/17-log-management.md). receiptNumber is non-PII; fiscalYear
      // helps narrow the search when an NPO asks for a year-of-account
      // export of their download history.
      request.log.info(
        {
          orgId,
          userId,
          donationId: id,
          receiptId: receipt.id,
          receiptNumber: receipt.receiptNumber,
          fiscalYear: receipt.fiscalYear,
        },
        "Receipt downloaded",
      );

      // Pin the filename to a safe shape so the column's `varchar(100)`
      // breadth — and any future writer (Salesforce import, manual SQL)
      // — can't smuggle quotes / CRLF through the response header.
      // Today's generator (`REC-YYYY-NNNN`) always matches; non-matching
      // numbers fall back to `receipt.pdf` rather than corrupting the
      // header (review feedback).
      const safeFilename = SAFE_RECEIPT_NUMBER_RE.test(receipt.receiptNumber)
        ? `${receipt.receiptNumber}.pdf`
        : "receipt.pdf";
      // `inline` so the donor-facing "Preview receipt" CTA actually
      // previews the PDF in the new tab (modern browsers render
      // application/pdf inline by default). The `filename=` is still
      // honored when the user hits "Save As".
      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `inline; filename="${safeFilename}"`)
        .header("Cache-Control", "private, no-store");
      const responseLength = resolveReceiptContentLength(decrypt, contentLength);
      if (responseLength !== null) {
        reply.header("Content-Length", responseLength);
      }
      return reply.send(responseStream);
    },
  );

  // Advanced-filter surfaces (flag `donations.advanced_filters`):
  // /donations/filter/{fields,preview,suggestions}.
  await registerDonationFilterRoutes(app);
}
