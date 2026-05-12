/**
 * Postal-campaign routes (Epic #274).
 *
 * Mounted under `/v1` from `server.ts`. Provides:
 *   - Campaign ↔ constituent membership: list / bulk-add / remove.
 *   - Async postal exports: start (202), list, get-status (poll), download.
 *   - Sync preview PDF (no DB writes, fake data).
 *   - QR-tracking metrics for the admin dashboard widget.
 *
 * Auth: all endpoints require `requireOrgAdmin`. Postal mailings are an
 * org-admin-only operation in scope (high-cost, customer-facing artefact).
 * Rationale: matches the existing `POST /v1/campaigns/:id/documents` gate.
 */

import { PassThrough } from "node:stream";
import { resolvePostalExportMode } from "@givernance/shared/postal-export-mode";
import { hasPageFromStatus } from "@givernance/shared/postal-print-layout";
import {
  bankAccounts,
  CAMPAIGN_TYPE_VALUES,
  campaignPublicPages,
  POSTAL_EXPORT_MODE_VALUES,
  POSTAL_EXPORT_STATUS_VALUES,
  tenants,
} from "@givernance/shared/schema";
import { computeQrr } from "@givernance/shared/validators";
import { Type } from "@sinclair/typebox";
import archiver from "archiver";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { env } from "../../env.js";
import { systemDb } from "../../lib/db.js";
import { requireOrgAdmin } from "../../lib/guards.js";
import { fetchCampaignObject } from "../../lib/s3.js";
import {
  DataArrayResponse,
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  PaginationQuery,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import { getActivePdfLetterhead } from "../branding/logo-cache.js";
import {
  addCampaignMembers,
  CampaignMembershipError,
  listCampaignMembers,
  removeCampaignMember,
} from "./constituents-service.js";
import {
  getPostalExport,
  listPostalExports,
  PostalExportError,
  startPostalExport,
} from "./postal-export-service.js";
import { renderPostalLetterToBuffer } from "./postal-pdf.js";
import { getCampaignQrStats } from "./qr-stats-service.js";
import { getCampaign } from "./service.js";
import { renderSwissQrBillPreviewToBuffer } from "./swiss-qr-bill-preview.js";

const PostalExportModeSchema = Type.Union(POSTAL_EXPORT_MODE_VALUES.map((v) => Type.Literal(v)));
const PostalExportStatusSchema = Type.Union(
  POSTAL_EXPORT_STATUS_VALUES.map((v) => Type.Literal(v)),
);
const CampaignTypeSchema = Type.Union(CAMPAIGN_TYPE_VALUES.map((v) => Type.Literal(v)));

const CampaignParams = Type.Object({ id: UuidSchema });
const CampaignAndConstituentParams = Type.Object({
  id: UuidSchema,
  constituentId: UuidSchema,
});
const CampaignAndExportParams = Type.Object({
  id: UuidSchema,
  exportId: UuidSchema,
});

const MemberRow = Type.Object({
  id: UuidSchema,
  constituentId: UuidSchema,
  firstName: Type.String(),
  lastName: Type.String(),
  email: Type.Union([Type.Null(), Type.String()]),
  type: Type.String(),
  addedAt: Type.String(),
  campaignDonationCents: Type.Integer(),
});

const AddMembersBody = Type.Object({
  /** Up to 500 ids per request to keep the validation pass cheap and bound the OR-list size. */
  constituentIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 500 }),
});

const AddMembersResult = Type.Object({
  added: Type.Integer(),
  skipped: Type.Integer(),
});

const RemoveMemberResult = Type.Object({
  removed: Type.Boolean(),
});

const StartExportBody = Type.Object({
  mode: PostalExportModeSchema,
});

const PostalExportRow = Type.Object({
  id: UuidSchema,
  campaignId: UuidSchema,
  mode: PostalExportModeSchema,
  status: PostalExportStatusSchema,
  totalCount: Type.Integer(),
  progressCount: Type.Integer(),
  zipS3Path: Type.Union([Type.Null(), Type.String()]),
  error: Type.Union([Type.Null(), Type.String()]),
  requestedBy: Type.Union([Type.Null(), UuidSchema]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  completedAt: Type.Union([Type.Null(), Type.String()]),
});

const QrStatsResponse = Type.Object({
  campaignId: UuidSchema,
  totalCodes: Type.Integer(),
  scannedCodes: Type.Integer(),
  qrAttributedDonations: Type.Integer(),
  qrAttributedAmountCents: Type.Integer(),
});

const PreviewBody = Type.Object({
  /**
   * `personalized` injects the canonical Jean Dupont fixture; `door_drop`
   * renders the generic letter shape (no recipient block). Defaults to
   * `personalized` so the admin sees the worst-case rendering.
   */
  mode: Type.Optional(PostalExportModeSchema),
});

export async function postalCampaignRoutes(app: FastifyInstance) {
  // ─── Campaign ↔ constituent membership ──────────────────────────────

  /** List the constituents linked to this campaign (paginated). */
  app.get(
    "/campaigns/:id/constituents",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: CampaignParams,
        querystring: PaginationQuery,
        response: { 200: DataArrayResponse(MemberRow), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const query = request.query as { page?: number; perPage?: number };
      const result = await listCampaignMembers(orgId, id, {
        page: query.page ?? 1,
        perPage: query.perPage ?? 25,
      });
      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }
      return result;
    },
  );

  /** Bulk-add constituents to this campaign. Idempotent — duplicates are skipped. */
  app.post(
    "/campaigns/:id/constituents",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: CampaignParams,
        body: AddMembersBody,
        response: {
          201: DataResponse(AddMembersResult),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const { constituentIds } = request.body as { constituentIds: string[] };
      try {
        const result = await addCampaignMembers(orgId, userId, id, constituentIds);
        if (!result) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
        }
        return reply.status(201).send({ data: result });
      } catch (err) {
        if (err instanceof CampaignMembershipError) {
          return reply.status(400).send(problemDetail(400, "Bad Request", err.message));
        }
        throw err;
      }
    },
  );

  /** Remove a single constituent from this campaign. Returns `removed: false` if no link exists. */
  app.delete(
    "/campaigns/:id/constituents/:constituentId",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: CampaignAndConstituentParams,
        response: { 200: DataResponse(RemoveMemberResult), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id, constituentId } = request.params as {
        id: string;
        constituentId: string;
      };
      const result = await removeCampaignMember(orgId, userId, id, constituentId);
      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }
      return { data: result };
    },
  );

  // ─── Postal exports ────────────────────────────────────────────────

  /**
   * Start a postal-export job. Returns 202 + the export row id. The frontend
   * polls `GET /campaigns/:id/postal-exports/:exportId` for progress.
   */
  app.post(
    "/campaigns/:id/postal-exports",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: CampaignParams,
        body: StartExportBody,
        response: {
          202: DataResponse(PostalExportRow),
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      const userId = request.auth?.userId;
      if (!orgId || !userId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const { mode } = request.body as { mode: "door_drop" | "personalized" };
      try {
        const result = await startPostalExport(orgId, userId, id, mode);
        if (!result) {
          return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
        }
        reply.header("Location", `/v1/campaigns/${id}/postal-exports/${result.id}`);
        return reply.status(202).send({ data: result });
      } catch (err) {
        if (err instanceof PostalExportError) {
          // Surface the structured `code` as the problem-detail title so
          // clients can branch on it (e.g. render specific remediation
          // banners for `campaign_not_active` / `public_page_draft`).
          // The free-text message stays in `detail` for direct display.
          return reply.status(400).send(problemDetail(400, err.code, err.message));
        }
        throw err;
      }
    },
  );

  /** List recent postal-export jobs for this campaign (newest first, capped at 20). */
  app.get(
    "/campaigns/:id/postal-exports",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: CampaignParams,
        response: {
          200: DataArrayResponseNoPagination(PostalExportRow),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const result = await listPostalExports(orgId, id);
      if (!result) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }
      return { data: result };
    },
  );

  /**
   * Get a single postal-export's current status. Designed for short-interval
   * polling — the frontend hits this every 2s while a job is in-flight.
   * Rate-limited at 60/min/admin so a buggy client (multiple tabs, runaway
   * useEffect, leaked credential) can't hammer the endpoint past the
   * intended polling cadence.
   */
  app.get(
    "/campaigns/:id/postal-exports/:exportId",
    {
      preHandler: requireOrgAdmin,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        tags: ["Campaigns"],
        params: CampaignAndExportParams,
        response: { 200: DataResponse(PostalExportRow), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id, exportId } = request.params as { id: string; exportId: string };
      const row = await getPostalExport(orgId, id, exportId);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Postal export not found"));
      }
      return { data: row };
    },
  );

  /**
   * Download the bundled ZIP for a completed postal export.
   *
   * Streams the object through the API instead of redirecting to a presigned
   * URL — same rationale as the receipts download (issue #214). Rate-limited
   * because admins refreshing the file repeatedly is a real attack vector
   * for storage-bandwidth burn.
   */
  app.get(
    "/campaigns/:id/postal-exports/:exportId/download",
    {
      preHandler: requireOrgAdmin,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Campaigns"],
        params: CampaignAndExportParams,
        response: { 409: ProblemDetailSchema, ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id, exportId } = request.params as { id: string; exportId: string };
      const row = await getPostalExport(orgId, id, exportId);
      if (!row) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Postal export not found"));
      }
      if (row.status !== "completed" || !row.zipS3Path) {
        return reply
          .status(409)
          .send(problemDetail(409, "Conflict", "Postal export is not yet ready for download"));
      }

      const { body, contentLength } = await fetchCampaignObject(row.zipS3Path);
      reply
        .header("content-type", "application/zip")
        .header(
          "content-disposition",
          `attachment; filename="campaign-${id}-export-${exportId}.zip"`,
        );
      if (contentLength !== undefined) {
        reply.header("content-length", String(contentLength));
      }
      return reply.send(body);
    },
  );

  // ─── Sync preview ──────────────────────────────────────────────────

  /**
   * Render a single sample postal letter and return it inline as a PDF.
   *
   * Synchronous, no DB writes, no QR codes registered — purely a "what does
   * the print job look like" check before the admin commits to a real
   * export. The fixture name stays "Jean Dupont" per the issue body so it's
   * unambiguous in screenshots that this is a preview.
   */
  app.post(
    "/campaigns/:id/postal-preview",
    {
      preHandler: requireOrgAdmin,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["Campaigns"],
        params: CampaignParams,
        body: PreviewBody,
        response: {
          400: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const body = request.body as { mode?: "door_drop" | "personalized" };
      const mode = body.mode ?? "personalized";

      const campaign = await getCampaign(orgId, id);
      if (!campaign) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }

      // Fetch the operator's organisation so the letterhead carries the real
      // org name (and mission, if the operator has filled it). systemDb
      // bypasses RLS — we already established `orgId` belongs to the
      // authenticated user via `requireOrgAdmin`, and we only read the row's
      // identity fields, never any secret material.
      const [tenant] = await systemDb
        .select({
          name: tenants.name,
          mission: tenants.mission,
          defaultLocale: tenants.defaultLocale,
        })
        .from(tenants)
        .where(eq(tenants.id, orgId))
        .limit(1);

      // Epic #318 PR #4 — resolve the preview mode the same way the
      // worker resolves the generation mode. Preview MUST match what
      // Generate produces (operator feedback on PR #354).
      // RLS defense-in-depth (minor #7 from PR #355 review): explicitly
      // filter the `campaignPublicPages` lookup on `orgId` even though
      // `requireOrgAdmin` already authenticated the operator + the
      // route narrowed to `campaign.orgId` upstream. The query runs via
      // `systemDb` (RLS-bypass), so a stray cross-tenant `campaignId`
      // collision would otherwise return another org's page row.
      const [publicPage] = await systemDb
        .select({ status: campaignPublicPages.status })
        .from(campaignPublicPages)
        .where(and(eq(campaignPublicPages.campaignId, id), eq(campaignPublicPages.orgId, orgId)))
        .limit(1);
      const runMode = resolvePostalExportMode({
        hasBank: campaign.bankAccountId !== null,
        // `hasPage = page row exists` (status: draft OR published) —
        // same semantics as postal-export-service's mode resolution.
        // The publish gate fires separately inside the standard/hybrid
        // path.
        hasPage: hasPageFromStatus(publicPage?.status),
      });
      if (runMode === "blocked") {
        return reply
          .status(400)
          .send(
            problemDetail(
              400,
              "postal_export_not_configured",
              "This campaign has neither a public donation page nor a linked bank account — there is nothing to preview.",
            ),
          );
      }

      const previewUrl = `${env.APP_URL}/p/${id}?preview=1`;
      const logoBuffer = await getActivePdfLetterhead(orgId);

      // Fixture recipient — door-drop preview = null (anonymous letter);
      // personalised + QR-bill modes = sample data for the C5 window block.
      const fixtureRecipient =
        mode === "door_drop"
          ? null
          : {
              firstName: "Jean",
              lastName: "Dupont",
              email: "jean.dupont@example.org",
              addressLine1: "12 rue de la République",
              addressLine2: null,
              postalCode: "75001",
              city: "Paris",
              countryCode: "FR",
            };

      const appealLetterInput = {
        organisationName: tenant?.name ?? "Your organisation",
        organisationMission: tenant?.mission ?? null,
        logoBuffer,
        campaignName: campaign.name,
        campaignDescription: campaign.description ?? null,
        locale: tenant?.defaultLocale ?? null,
        qrPayload: previewUrl,
        recipient: fixtureRecipient,
        qrReference: "PREVIEW-SAMPLE",
        preview: true,
      };

      // ─── Standard mode → single inline PDF (today's behaviour). ────
      if (runMode === "standard") {
        const buffer = await renderPostalLetterToBuffer(appealLetterInput);
        reply
          .header("content-type", "application/pdf")
          .header("content-disposition", 'inline; filename="postal-preview.pdf"')
          .header("content-length", String(buffer.byteLength));
        return reply.send(buffer);
      }

      // Modes that need the bank account → load it once.
      const [bankAccount] = await systemDb
        .select({
          iban: bankAccounts.iban,
          holderName: bankAccounts.holderName,
          holderStreet: bankAccounts.holderStreet,
          holderBuildingNumber: bankAccounts.holderBuildingNumber,
          holderPostalCode: bankAccounts.holderPostalCode,
          holderTown: bankAccounts.holderTown,
          holderCountryCode: bankAccounts.holderCountryCode,
          currency: bankAccounts.currency,
        })
        .from(bankAccounts)
        .where(
          and(
            // biome-ignore lint/style/noNonNullAssertion: guarded by runMode resolution above
            eq(bankAccounts.id, campaign.bankAccountId!),
            eq(bankAccounts.orgId, orgId),
            isNull(bankAccounts.deletedAt),
          ),
        )
        .limit(1);
      if (!bankAccount) {
        return reply
          .status(400)
          .send(
            problemDetail(
              400,
              "swiss_qr_bill_bank_account_deleted",
              "Linked bank account is missing or soft-deleted.",
            ),
          );
      }

      // 27-digit fixture QRR with a valid mod-10 check digit — never
      // registered in `swiss_qr_references` so a real bank scanning the
      // preview will reject it (safe). Computed via the canonical Swiss
      // "Modulo 10 recursive" helper rather than hand-rolling the check
      // digit: a future tweak to the helper (or to the 26-char body
      // sentinel below) cannot silently desync from the validator and
      // produce an invalid fixture that the swissqrbill library would
      // reject at render time.
      const previewReference = computeQrr("21000000000000000000000000");

      // ─── QR-bill only mode → single inline 2-page PDF. ─────────────
      if (runMode === "qr_bill_only") {
        const buffer = await renderSwissQrBillPreviewToBuffer({
          ...appealLetterInput,
          bankAccount,
          reference: previewReference,
        });
        reply
          .header("content-type", "application/pdf")
          .header("content-disposition", 'inline; filename="postal-preview-qr-bill.pdf"')
          .header("content-length", String(buffer.byteLength));
        return reply.send(buffer);
      }

      // ─── Hybrid mode → streamed ZIP with two PDFs. ─────────────────
      // The browser doesn't render ZIPs inline — operator gets a download.
      // This is honest about what Generate produces (2 sibling PDFs per
      // recipient) rather than collapsing into a side-by-side single PDF
      // that would lie about the print artefact.
      const [letterBuffer, qrBillBuffer] = await Promise.all([
        renderPostalLetterToBuffer(appealLetterInput),
        renderSwissQrBillPreviewToBuffer({
          ...appealLetterInput,
          bankAccount,
          reference: previewReference,
        }),
      ]);
      const passthrough = new PassThrough();
      const archive = archiver("zip", { zlib: { level: 6 } });
      archive.on("error", (err) => passthrough.destroy(err));
      archive.pipe(passthrough);
      archive.append(letterBuffer, { name: "postal-preview-letter.pdf" });
      archive.append(qrBillBuffer, { name: "postal-preview-qr-bill.pdf" });
      void archive.finalize();
      reply
        .header("content-type", "application/zip")
        .header("content-disposition", 'attachment; filename="postal-preview.zip"');
      return reply.send(passthrough);
    },
  );

  // ─── QR tracking metrics ───────────────────────────────────────────

  /** QR-tracking summary for the campaign admin dashboard. */
  app.get(
    "/campaigns/:id/qr-stats",
    {
      preHandler: requireOrgAdmin,
      schema: {
        tags: ["Campaigns"],
        params: IdParams,
        response: { 200: DataResponse(QrStatsResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = request.auth?.orgId;
      if (!orgId) {
        return reply.status(401).send(problemDetail(401, "Unauthorized", "Missing auth context"));
      }
      const { id } = request.params as { id: string };
      const stats = await getCampaignQrStats(orgId, id);
      if (!stats) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Campaign not found"));
      }
      return { data: stats };
    },
  );

  // Avoid an unused-symbol lint by exporting the campaign-type schema if a
  // future route consumes it directly. Today it lives only inside the
  // service layer's narrowing.
  void CampaignTypeSchema;
}
