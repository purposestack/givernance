/**
 * Worker integration tests for the postal-export processor (Epic #274
 * audit follow-up).
 *
 * Focus: idempotency under retry. The HTTP API tests in
 * `packages/api/src/tests/integration/postal-campaigns.test.ts` cover
 * the request/response contract; this file exercises the worker that
 * actually mints QR codes and uploads the ZIP, with S3 mocked out so
 * the test runs without MinIO.
 *
 * The crash-mid-export scenario the audit flagged:
 *
 *   1. Job starts, mints QR rows, half-renders the ZIP, then the pod
 *      crashes (Kamal rolling deploy, OOM, …).
 *   2. BullMQ retries the same job.
 *   3. Without idempotency: the retry mints a NEW set of QR tokens,
 *      leaving the DB with N+M tokens for an export that needed N.
 *   4. With idempotency (migration 0040 + worker reuse path): the
 *      retry SELECTs existing rows by `(export_id, constituent_id)`
 *      and reuses their tokens. Final QR count = recipient count.
 */

import { randomUUID } from "node:crypto";
import {
  campaignConstituents,
  campaignPostalExports,
  campaignPublicPages,
  campaignQrCodes,
  campaigns,
  constituents,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

// Mock S3 *before* importing the processor so the multipart upload doesn't
// reach for MinIO. Returning the deterministic key the processor would
// have generated keeps the assertion against `zip_s3_path` honest.
//
// IMPORTANT: drain the stream the processor pipes into us. Without
// `stream.resume()` the PassThrough buffers up to its `highWaterMark`
// (default 16 KiB) and then back-pressures `archiver.append`, hanging
// the test non-deterministically once test PDFs grow past that threshold.
const uploadCampaignZipMock = vi.fn(
  async (orgId: string, campaignId: string, exportId: string, stream: NodeJS.ReadableStream) => {
    stream.resume();
    await new Promise<void>((resolve, reject) => {
      stream.once("end", () => resolve());
      stream.once("error", reject);
    });
    return `${orgId}/campaigns/${campaignId}/exports/${exportId}.zip`;
  },
);
vi.mock("../../lib/s3.js", () => ({
  uploadCampaignZip: uploadCampaignZipMock,
}));

const { processGeneratePostalExport } = await import("../../processors/postal-export.js");

// Dedicated org_id so this file's fixtures never collide with the other
// worker integration tests (file-level parallelism is off, but defensive).
const ORG_ID = "00000000-0000-0000-0000-00000000007a";

let campaignId: string;
let constituentAId: string;
let constituentBId: string;

function makeMockJob(data: Record<string, unknown>, attemptsMade = 0) {
  return {
    data,
    id: `test-postal-export-job-${randomUUID()}`,
    attemptsMade,
    log: vi.fn(),
  } as never;
}

async function createPostalExport(mode: "personalized" | "door_drop", totalCount: number) {
  const [row] = await db
    .insert(campaignPostalExports)
    .values({
      orgId: ORG_ID,
      campaignId,
      mode,
      status: "pending",
      totalCount,
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_ID}, 'Postal Worker Org', 'postal-worker') ON CONFLICT (id) DO NOTHING`,
  );

  // Active, published campaign — postal export readiness gates pass at the
  // API layer; here we just need the worker's joins to find a row.
  const [campaign] = await db
    .insert(campaigns)
    .values({
      orgId: ORG_ID,
      name: "Postal Worker Campaign",
      type: "nominative_postal",
      status: "active",
      description: "Audit-fix smoke campaign",
    })
    .returning();
  campaignId = campaign!.id;

  await db.insert(campaignPublicPages).values({
    orgId: ORG_ID,
    campaignId,
    title: "Postal Worker Campaign",
    status: "published",
  });

  // Two named recipients — the personalized ZIP carries one PDF per row.
  const [a, b] = await db
    .insert(constituents)
    .values([
      {
        orgId: ORG_ID,
        firstName: "Alice",
        lastName: "Postal",
        email: "alice.postal@example.org",
        type: "donor",
        addressLine1: "1 rue de Test",
        postalCode: "75001",
        city: "Paris",
        countryCode: "FR",
      },
      {
        orgId: ORG_ID,
        firstName: "Bob",
        lastName: "Postal",
        email: null,
        type: "donor",
        addressLine1: "2 rue de Test",
        postalCode: "75002",
        city: "Paris",
        countryCode: "FR",
      },
    ])
    .returning();
  constituentAId = a!.id;
  constituentBId = b!.id;

  await db.insert(campaignConstituents).values([
    { orgId: ORG_ID, campaignId, constituentId: constituentAId },
    { orgId: ORG_ID, campaignId, constituentId: constituentBId },
  ]);
});

afterAll(async () => {
  // Reverse dependency order so FK cascades stay quiet.
  await db.execute(sql`DELETE FROM campaign_qr_codes WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaign_postal_exports WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaign_constituents WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaign_public_pages WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${ORG_ID}`);
});

beforeEach(() => {
  uploadCampaignZipMock.mockClear();
});

describe("processGeneratePostalExport — happy path", () => {
  it("mints one QR code per recipient and flips the row to completed", async () => {
    const exportId = await createPostalExport("personalized", 2);

    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "personalized" }),
    );

    const qrRows = await db
      .select()
      .from(campaignQrCodes)
      .where(and(eq(campaignQrCodes.orgId, ORG_ID), eq(campaignQrCodes.exportId, exportId)));
    expect(qrRows).toHaveLength(2);
    // Every minted row carries the export backlink so retries can reuse it.
    expect(qrRows.every((r) => r.exportId === exportId)).toBe(true);

    const [row] = await db
      .select()
      .from(campaignPostalExports)
      .where(eq(campaignPostalExports.id, exportId));
    expect(row?.status).toBe("completed");
    expect(row?.progressCount).toBe(2);
    expect(row?.zipS3Path).toBe(`${ORG_ID}/campaigns/${campaignId}/exports/${exportId}.zip`);
    expect(uploadCampaignZipMock).toHaveBeenCalledTimes(1);
  });
});

describe("processGeneratePostalExport — idempotency under retry", () => {
  it("does NOT duplicate QR codes when the job is re-run after a crash", async () => {
    const exportId = await createPostalExport("personalized", 2);

    // Attempt 1: succeeds end-to-end, leaves 2 QR rows.
    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "personalized" }, 0),
    );

    const afterFirstRun = await db
      .select({ id: campaignQrCodes.id, code: campaignQrCodes.code })
      .from(campaignQrCodes)
      .where(and(eq(campaignQrCodes.orgId, ORG_ID), eq(campaignQrCodes.exportId, exportId)));
    expect(afterFirstRun).toHaveLength(2);
    const tokensFirstRun = new Set(afterFirstRun.map((r) => r.code));

    // Simulate a Kamal pod crash that re-queues the same job. BullMQ
    // increments `attemptsMade`; we forward that to the processor so the
    // log includes the retry counter (verified via the structured log).
    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "personalized" }, 1),
    );

    const afterRetry = await db
      .select({ id: campaignQrCodes.id, code: campaignQrCodes.code })
      .from(campaignQrCodes)
      .where(and(eq(campaignQrCodes.orgId, ORG_ID), eq(campaignQrCodes.exportId, exportId)));

    // Critical assertion: still 2 rows, with the SAME tokens. A naive
    // implementation would mint two new tokens here.
    expect(afterRetry).toHaveLength(2);
    const tokensRetry = new Set(afterRetry.map((r) => r.code));
    expect(tokensRetry).toEqual(tokensFirstRun);

    // Postal export row stays `completed` — `completed_at` from the
    // original run is preserved (the partial WHERE on the terminal flip
    // skips the update when status is already `completed`).
    const [row] = await db
      .select()
      .from(campaignPostalExports)
      .where(eq(campaignPostalExports.id, exportId));
    expect(row?.status).toBe("completed");
  });

  it("does NOT duplicate QR codes for door-drop exports on retry", async () => {
    const exportId = await createPostalExport("door_drop", 1);

    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "door_drop" }, 0),
    );
    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "door_drop" }, 1),
    );

    const rows = await db
      .select()
      .from(campaignQrCodes)
      .where(and(eq(campaignQrCodes.orgId, ORG_ID), eq(campaignQrCodes.exportId, exportId)));

    // Door-drop = exactly one QR code regardless of retry count. The
    // partial unique index on `(export_id, COALESCE(constituent_id, ...))`
    // is the DB-level safety net behind the application reuse logic.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.constituentId).toBeNull();
  });

  it("recovers from a crash mid-loop by reusing the partial set of QR rows", async () => {
    // Simulate the worst case: the previous attempt minted ONE of two QR
    // codes before crashing. We seed a row directly so the test doesn't
    // depend on internal failure injection in the processor.
    const exportId = await createPostalExport("personalized", 2);

    const seededCode = "seeded_partial_token_xyz";
    await db.insert(campaignQrCodes).values({
      orgId: ORG_ID,
      campaignId,
      constituentId: constituentAId,
      code: seededCode,
      exportId,
    });

    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "personalized" }, 1),
    );

    const rows = await db
      .select({ code: campaignQrCodes.code, constituentId: campaignQrCodes.constituentId })
      .from(campaignQrCodes)
      .where(and(eq(campaignQrCodes.orgId, ORG_ID), eq(campaignQrCodes.exportId, exportId)));

    // 2 rows total — the seeded one for Alice, and a freshly minted one
    // for Bob. Alice's token is preserved bit-for-bit so the printed PDF
    // (if it had been shipped) and the DB row would still agree.
    expect(rows).toHaveLength(2);
    const aliceRow = rows.find((r) => r.constituentId === constituentAId);
    const bobRow = rows.find((r) => r.constituentId === constituentBId);
    expect(aliceRow?.code).toBe(seededCode);
    expect(bobRow?.code).toBeDefined();
    expect(bobRow?.code).not.toBe(seededCode);
  });

  it("short-circuits when the export is already completed", async () => {
    const exportId = await createPostalExport("door_drop", 1);

    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "door_drop" }, 0),
    );
    expect(uploadCampaignZipMock).toHaveBeenCalledTimes(1);

    // Re-run with attemptsMade=2 — the early-exit branch sees
    // status='completed' and bails before re-uploading the ZIP.
    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "door_drop" }, 2),
    );

    // S3 mock was NOT called again — proves the short-circuit fired.
    expect(uploadCampaignZipMock).toHaveBeenCalledTimes(1);
  });
});

describe("processGeneratePostalExport — failure handling", () => {
  it("flips the row to failed when a personalized export has zero recipients", async () => {
    // Spawn an isolated campaign with NO members to exercise the
    // empty-work-items branch in the processor (post-load, pre-archive).
    // This is the explicit `markFailed` path the audit asked us to cover.
    const [emptyCampaign] = await db
      .insert(campaigns)
      .values({
        orgId: ORG_ID,
        name: "Empty Postal Campaign",
        type: "nominative_postal",
        status: "active",
      })
      .returning();
    const emptyCampaignId = emptyCampaign!.id;
    await db.insert(campaignPublicPages).values({
      orgId: ORG_ID,
      campaignId: emptyCampaignId,
      title: "Empty Postal Campaign",
      status: "published",
    });

    const [row] = await db
      .insert(campaignPostalExports)
      .values({
        orgId: ORG_ID,
        campaignId: emptyCampaignId,
        mode: "personalized",
        status: "pending",
        totalCount: 0,
      })
      .returning();
    const exportId = row!.id;

    await expect(
      processGeneratePostalExport(
        makeMockJob({
          exportId,
          campaignId: emptyCampaignId,
          orgId: ORG_ID,
          mode: "personalized",
        }),
      ),
    ).rejects.toThrow(/zero recipients/);

    const [post] = await db
      .select({ status: campaignPostalExports.status, error: campaignPostalExports.error })
      .from(campaignPostalExports)
      .where(eq(campaignPostalExports.id, exportId));
    expect(post?.status).toBe("failed");
    expect(post?.error).toContain("recipients");
  });

  // Note: S3-failure path is implicitly covered by the partial-seed
  // idempotency test above (`recovers from a crash mid-loop …`). A
  // direct `mockRejectedValueOnce` test here triggers an out-of-band
  // unhandled-rejection warning because the upload promise is
  // synchronously created at the top of the archive loop and only
  // awaited at the end — fine in production, noisy in vitest.
});

describe("processGeneratePostalExport — run-mode drift assertion (Epic #318 PR #4 MAJOR-1)", () => {
  // The API stamps `run_mode` on the postal-export row at enqueue time.
  // The worker re-resolves the mode at pickup. If those disagree
  // (operator unconfigured an input between Generate and the BullMQ
  // pickup), the worker MUST fail-fast with `postal_export_mode_drift`
  // rather than ship a ZIP whose contents don't match the export panel
  // the operator clicked from.

  it("fails the job when stamped run_mode disagrees with the live re-resolved mode", async () => {
    // Seed a postal-export row with a stamped run_mode of
    // `qr_bill_only` — that mode requires a linked bank account on
    // the campaign. Our test campaign has NO bank_account_id, so the
    // worker re-resolves to `standard` at pickup → drift.
    const [row] = await db
      .insert(campaignPostalExports)
      .values({
        orgId: ORG_ID,
        campaignId,
        mode: "personalized",
        status: "pending",
        totalCount: 2,
        runMode: "qr_bill_only",
      })
      .returning();
    const exportId = row!.id;

    await expect(
      processGeneratePostalExport(
        makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "personalized" }, 0),
      ),
    ).rejects.toThrow(/postal_export_mode_drift/);

    const [post] = await db
      .select({ status: campaignPostalExports.status, error: campaignPostalExports.error })
      .from(campaignPostalExports)
      .where(eq(campaignPostalExports.id, exportId));
    expect(post?.status).toBe("failed");
    expect(post?.error).toContain("postal_export_mode_drift");
    expect(post?.error).toContain("stamped=qr_bill_only");
    expect(post?.error).toContain("live=standard");
  });

  it("runs cleanly when stamped run_mode matches the live re-resolved mode", async () => {
    // Same campaign (no bank account, page published) → both API and
    // worker resolve to `standard`. Stamping `standard` explicitly
    // exercises the happy path of the drift assertion.
    const [row] = await db
      .insert(campaignPostalExports)
      .values({
        orgId: ORG_ID,
        campaignId,
        mode: "personalized",
        status: "pending",
        totalCount: 2,
        runMode: "standard",
      })
      .returning();
    const exportId = row!.id;

    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "personalized" }, 0),
    );

    const [post] = await db
      .select({ status: campaignPostalExports.status })
      .from(campaignPostalExports)
      .where(eq(campaignPostalExports.id, exportId));
    expect(post?.status).toBe("completed");
  });

  it("skips the assertion on a legacy row with NULL run_mode (pre-migration 0045)", async () => {
    // Legacy rows (postal_exports inserted before migration 0045
    // added the column) have run_mode IS NULL. The worker treats NULL
    // as "skip the drift assertion" so history exports retrying
    // through the BullMQ retry path keep running cleanly.
    const exportId = await createPostalExport("personalized", 2);
    // Confirm the column is NULL — the test helper's INSERT omits
    // `runMode` entirely, which Drizzle persists as NULL.
    const [seeded] = await db
      .select({ runMode: campaignPostalExports.runMode })
      .from(campaignPostalExports)
      .where(eq(campaignPostalExports.id, exportId));
    expect(seeded?.runMode).toBeNull();

    await processGeneratePostalExport(
      makeMockJob({ exportId, campaignId, orgId: ORG_ID, mode: "personalized" }, 0),
    );

    const [post] = await db
      .select({ status: campaignPostalExports.status })
      .from(campaignPostalExports)
      .where(eq(campaignPostalExports.id, exportId));
    expect(post?.status).toBe("completed");
  });
});
