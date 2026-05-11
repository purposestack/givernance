/**
 * Postal-export service — async PDF/ZIP archive generation for postal
 * campaigns (Epic #274). The HTTP path stays under 100ms; all heavy lifting
 * (PDF rendering, ZIP bundling, S3 upload) runs in the BullMQ worker.
 *
 * Lifecycle:
 *   1. POST /campaigns/:id/postal-exports → service inserts a `pending` row,
 *      emits `campaign.postal_export_requested`, returns the row id.
 *   2. Outbox relay → BullMQ → worker `postal-export.ts` flips status to
 *      `processing`, ticks `progressCount` per PDF, uploads ZIP, marks
 *      `completed` (with `zipS3Path`) or `failed` (with `error`).
 *   3. Frontend polls GET /campaigns/:id/postal-exports/:exportId every ~2s
 *      to render the progress bar.
 *   4. GET /campaigns/:id/postal-exports/:exportId/download streams the
 *      ZIP from S3 through the API (mirrors the receipts download pattern
 *      from issue #214 — keeps the donor-visible URL on the app's apex
 *      and avoids signed-URL hostname issues on the staging MinIO).
 */

import {
  bankAccounts,
  campaignConstituents,
  campaignPostalExports,
  campaignPublicPages,
  campaigns,
  constituents,
  outboxEvents,
  type PostalExportMode,
} from "@givernance/shared/schema";
import { classifyIban } from "@givernance/shared/validators";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";
import { resolveInternalUserId } from "../../lib/resolve-user.js";

/**
 * Structured error code for `startPostalExport` failures so the route
 * handler can map each cause to a stable problem-detail title and the
 * frontend can surface specific remediation hints. Free-text `message`
 * is still the human description.
 */
export type PostalExportErrorCode =
  | "campaign_not_active"
  | "public_page_missing"
  | "public_page_draft"
  | "personalized_on_door_drop"
  | "no_recipients"
  // Epic #318: Swiss QR-bill readiness gates — fire only when the
  // campaign has `bank_account_id IS NOT NULL`. A NULL bank account
  // keeps the campaign on the standard postal rail (no QR-bill, no
  // Swiss-specific checks).
  | "swiss_qr_bill_bank_account_deleted"
  | "swiss_qr_bill_invalid_iban"
  | "swiss_qr_bill_currency_mismatch"
  | "swiss_qr_bill_address_too_long"
  | "insert_failed";

export class PostalExportError extends Error {
  constructor(
    message: string,
    public readonly code: PostalExportErrorCode = "insert_failed",
  ) {
    super(message);
    this.name = "PostalExportError";
  }
}

export interface PostalExportRow {
  id: string;
  campaignId: string;
  mode: PostalExportMode;
  status: "pending" | "processing" | "completed" | "failed";
  totalCount: number;
  progressCount: number;
  zipS3Path: string | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function mapRow(row: {
  id: string;
  campaignId: string;
  mode: PostalExportMode;
  status: "pending" | "processing" | "completed" | "failed";
  totalCount: number;
  progressCount: number;
  zipS3Path: string | null;
  error: string | null;
  requestedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}): PostalExportRow {
  return {
    id: row.id,
    campaignId: row.campaignId,
    mode: row.mode,
    status: row.status,
    totalCount: row.totalCount,
    progressCount: row.progressCount,
    zipS3Path: row.zipS3Path,
    error: row.error,
    requestedBy: row.requestedBy,
    // biome-ignore lint/style/noNonNullAssertion: Drizzle returns Date for these timestamp columns
    createdAt: toIso(row.createdAt)!,
    // biome-ignore lint/style/noNonNullAssertion: same
    updatedAt: toIso(row.updatedAt)!,
    completedAt: toIso(row.completedAt),
  };
}

/**
 * Epic #318 — Swiss QR-bill readiness gates. Fires only when the
 * campaign has `bank_account_id IS NOT NULL`. The gates here are the
 * **server-side mirror** of the form-level checks in
 * `web/components/settings/bank-account-form.tsx` and of the DB CHECK
 * constraints from migration 0044 — defense-in-depth so the worker
 * never sees a payload that would fail at PDF render time.
 *
 * `qrReferenceMode='auto'` resolves to `qrr` for QR-IBANs and `scor`
 * for regular IBANs — see ADR-027. The currency-vs-reference rule
 * (EUR + QRR illegal under IG QR-bill v2.4 after the euroSIC
 * discontinuation) fires here AND at the bank-account create-time
 * service guard.
 */
async function assertSwissQrBillReadiness(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  bankAccountId: string,
  qrReferenceMode: "auto" | "qrr" | "scor",
): Promise<void> {
  const [account] = await tx
    .select({
      id: bankAccounts.id,
      deletedAt: bankAccounts.deletedAt,
      iban: bankAccounts.iban,
      ibanKind: bankAccounts.ibanKind,
      currency: bankAccounts.currency,
      holderName: bankAccounts.holderName,
      holderStreet: bankAccounts.holderStreet,
      holderBuildingNumber: bankAccounts.holderBuildingNumber,
      holderPostalCode: bankAccounts.holderPostalCode,
      holderTown: bankAccounts.holderTown,
    })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.orgId, orgId)));

  if (!account || account.deletedAt !== null) {
    throw new PostalExportError(
      "Linked bank account was soft-deleted. Pick a different bank account or restore it before generating a postal export.",
      "swiss_qr_bill_bank_account_deleted",
    );
  }

  // Defense-in-depth: the bank_accounts CHECK + service-level validator
  // enforce CH/LI + mod-97 at write time, so this branch should never
  // fire on a row created via the API. It catches DB-direct writes that
  // bypassed those guards.
  if (classifyIban(account.iban) === "invalid") {
    throw new PostalExportError(
      "Linked bank account has an IBAN that failed mod-97 / CH-or-LI validation. Re-create the bank account.",
      "swiss_qr_bill_invalid_iban",
    );
  }

  const effectiveMode =
    qrReferenceMode === "auto"
      ? account.ibanKind === "qr_iban"
        ? "qrr"
        : "scor"
      : qrReferenceMode;
  if (account.currency === "EUR" && effectiveMode === "qrr") {
    throw new PostalExportError(
      "EUR + QRR is illegal under IG QR-bill v2.4 (euroSIC discontinuation). Switch the campaign's qrReferenceMode to SCOR or change the bank account currency.",
      "swiss_qr_bill_currency_mismatch",
    );
  }

  // IG QR-bill v2.4 holder-field caps. These match the DB column widths
  // exactly, so any row that wrote successfully should pass — but a UI
  // patch path could still in theory truncate before saving; better to
  // surface the offending field here than at render time.
  const overruns = [
    account.holderName.length > 70 && "holder name (>70)",
    account.holderStreet.length > 70 && "holder street (>70)",
    account.holderBuildingNumber !== null && account.holderBuildingNumber.length > 16
      ? "holder building number (>16)"
      : false,
    account.holderPostalCode.length > 16 && "holder postal code (>16)",
    account.holderTown.length > 35 && "holder town (>35)",
  ].filter(Boolean);
  if (overruns.length > 0) {
    throw new PostalExportError(
      `Holder address exceeds IG QR-bill v2.4 caps: ${overruns.join(", ")}. Edit the bank account before exporting.`,
      "swiss_qr_bill_address_too_long",
    );
  }
}

/** Count linked constituents for a campaign (used to lock the totalCount at job-start). */
async function countLinkedConstituents(
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0],
  orgId: string,
  campaignId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(campaignConstituents)
    .innerJoin(constituents, eq(constituents.id, campaignConstituents.constituentId))
    .where(
      and(
        eq(campaignConstituents.orgId, orgId),
        eq(campaignConstituents.campaignId, campaignId),
        isNull(constituents.deletedAt),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * Start a new postal export job.
 *
 * For `personalized` mode the campaign must be `nominative_postal` and have
 * at least one linked constituent — bouncing the request here keeps the
 * worker focused on actual work (no "0 PDFs in a ZIP" empty-archive jobs).
 *
 * For `door_drop` mode any campaign type works (the door-drop letter is
 * generic by definition); `totalCount` is locked to 1 — we generate one
 * representative PDF + QR code that the org can mass-print themselves.
 */
export async function startPostalExport(
  orgId: string,
  userId: string,
  campaignId: string,
  mode: PostalExportMode,
): Promise<PostalExportRow | null> {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({
        id: campaigns.id,
        type: campaigns.type,
        status: campaigns.status,
        bankAccountId: campaigns.bankAccountId,
        qrReferenceMode: campaigns.qrReferenceMode,
      })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    // Readiness gate 1 — campaign must be active. A draft campaign is still
    // being designed (recipients aren't final, copy may change); a closed
    // campaign would print QR codes that drive money to a no-longer-running
    // appeal. Both are user-error states, not engineering failures, so we
    // surface them with structured codes the UI can render specific banners
    // for.
    if (campaign.status !== "active") {
      throw new PostalExportError(
        "Campaign must be active before generating a postal export. Activate the campaign first.",
        "campaign_not_active",
      );
    }

    // Readiness gate 2 — the public donation page must be published. The
    // QR codes printed on the letters resolve to `/p/:campaignId`, which
    // 404s if the public page is missing or in draft (cf.
    // `public/service.ts` filters `WHERE status = 'published'`). Catching
    // this here is far cheaper than catching it in the donor's hand.
    const [publicPage] = await tx
      .select({ status: campaignPublicPages.status })
      .from(campaignPublicPages)
      .where(eq(campaignPublicPages.campaignId, campaignId));

    if (!publicPage) {
      throw new PostalExportError(
        "Public donation page does not exist. Configure and publish it before generating a postal export.",
        "public_page_missing",
      );
    }
    if (publicPage.status !== "published") {
      throw new PostalExportError(
        "Public donation page is still a draft. Publish it before generating a postal export — otherwise donors scanning the printed QR codes won't reach a working donation page.",
        "public_page_draft",
      );
    }

    // Epic #318 — Swiss QR-bill readiness gates (only when linked).
    if (campaign.bankAccountId !== null) {
      await assertSwissQrBillReadiness(tx, orgId, campaign.bankAccountId, campaign.qrReferenceMode);
    }

    let totalCount = 0;
    if (mode === "personalized") {
      if (campaign.type === "door_drop") {
        throw new PostalExportError(
          "Cannot run a personalized export on a door-drop campaign — switch the export mode to door_drop or use a nominative campaign",
          "personalized_on_door_drop",
        );
      }
      totalCount = await countLinkedConstituents(tx, orgId, campaignId);
      if (totalCount === 0) {
        throw new PostalExportError(
          "Personalized export requires at least one linked constituent. Add recipients to the campaign first.",
          "no_recipients",
        );
      }
    } else {
      totalCount = 1;
    }

    // `userId` is the JWT subject (= keycloak id). `requested_by` is a
    // FK to `users.id` (internal UUID), so we MUST translate. Falls back
    // to NULL when the JWT subject doesn't match an active member of
    // the tenant (impersonated platform admin in delegation mode against
    // a tenant they don't belong to — the audit trail still captures
    // `actor_id` and `impersonation_session_id` separately).
    const requestedByInternal = await resolveInternalUserId(tx, orgId, userId);

    const [inserted] = await tx
      .insert(campaignPostalExports)
      .values({
        orgId,
        campaignId,
        mode,
        status: "pending",
        totalCount,
        progressCount: 0,
        requestedBy: requestedByInternal,
      })
      .returning();

    if (!inserted) {
      throw new PostalExportError("Failed to enqueue postal export", "insert_failed");
    }

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "campaign.postal_export_requested",
      payload: {
        exportId: inserted.id,
        campaignId,
        mode,
        totalCount,
        // Outbox payload keeps the JWT subject (= keycloak id) — it's an
        // opaque audit trail value, not an FK.
        requestedBy: userId,
      },
    });

    return mapRow(inserted);
  });
}

/** List recent postal exports for a campaign (newest first, no pagination — capped at 20). */
export async function listPostalExports(
  orgId: string,
  campaignId: string,
): Promise<PostalExportRow[] | null> {
  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const rows = await tx
      .select()
      .from(campaignPostalExports)
      .where(
        and(
          eq(campaignPostalExports.orgId, orgId),
          eq(campaignPostalExports.campaignId, campaignId),
        ),
      )
      .orderBy(desc(campaignPostalExports.createdAt))
      .limit(20);

    return rows.map(mapRow);
  });
}

/** Get a single postal export by id. Used for polling progress. */
export async function getPostalExport(
  orgId: string,
  campaignId: string,
  exportId: string,
): Promise<PostalExportRow | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(campaignPostalExports)
      .where(
        and(
          eq(campaignPostalExports.id, exportId),
          eq(campaignPostalExports.orgId, orgId),
          eq(campaignPostalExports.campaignId, campaignId),
        ),
      );

    return row ? mapRow(row) : null;
  });
}
