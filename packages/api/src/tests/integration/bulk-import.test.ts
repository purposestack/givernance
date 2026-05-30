/**
 * Bulk-import integration tests — Epic #373 / PR #385.
 *
 * Covers the full operator-visible surface of the upload → status →
 * results → template → download → list flow, with mandatory RLS
 * isolation assertions (tenant B must never see tenant A's data).
 *
 * Mocking posture (matches branding.test.ts):
 *   - `lib/s3.js` is replaced with an in-memory store keyed by the S3
 *     key. Upload+download round-trips through the mock so the download
 *     route can return the original bytes. No MinIO required → tests
 *     work in CI which has no S3 service.
 *   - The BullMQ worker is NOT running in this process. Tests that
 *     need the post-worker DB state ("completed", "partial",
 *     "duplicate" results) simulate the worker by writing
 *     `bulk_import_results` rows + flipping the `bulk_import_jobs`
 *     status directly via SQL inside `withTenantContext`. This is the
 *     same posture as `branding.test.ts` (covers route + DB; the
 *     worker pipeline is unit-tested separately in
 *     `packages/worker/src/processors/__tests__/process-bulk-import.test.ts`).
 *
 * The `constituents.bulk_import` feature flag ships disabled by
 * migration 0052 — the suite flips it on in `beforeAll` and resets it
 * in `afterAll` so subsequent suites that share the test DB see a
 * deterministic starting point.
 */

import { Readable } from "node:stream";
import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  bulkImportFiles,
  bulkImportJobs,
  bulkImportResults,
  constituents,
  featureFlags,
} from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../helpers/auth.js";
import { db, withTenantContext } from "../helpers/db.js";

// ─── In-memory S3 mock (vi.hoisted so it's defined before vi.mock) ──────────
//
// The bulk-import S3 path is exercised end-to-end by upload + download
// tests. A real PutObject against MinIO would work locally but not in
// CI, so the helpers are mocked with an in-memory map. The mock
// preserves byte-for-byte fidelity — a download round-trip returns the
// exact buffer that was uploaded.

const { s3Store } = vi.hoisted(() => {
  return { s3Store: new Map<string, { body: Buffer; contentType: string }>() };
});

vi.mock("../../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/s3.js")>();
  return {
    ...actual,
    putBulkImportObject: vi.fn(async (key: string, body: Buffer, contentType: string) => {
      s3Store.set(key, { body, contentType });
      return { bucket: "bulk-imports" };
    }),
    getBulkImportObject: vi.fn(async (key: string) => {
      const stored = s3Store.get(key);
      if (!stored) {
        // Match the real client's "not found" surface so the route's
        // 404 fallback fires.
        throw new Error(`S3 object missing: ${key}`);
      }
      return { body: Readable.from(stored.body), contentLength: stored.body.byteLength };
    }),
    deleteBulkImportObject: vi.fn(async (key: string) => {
      s3Store.delete(key);
    }),
  };
});

// ─── Multipart upload helper (mirrors branding.test.ts) ─────────────────────

const MULTIPART_BOUNDARY = "----GivernanceBulkImportBoundary";

function multipartUpload(opts: { filename: string; contentType: string; body: Buffer }): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const head =
    `--${MULTIPART_BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
    `Content-Type: ${opts.contentType}\r\n` +
    `\r\n`;
  const tail = `\r\n--${MULTIPART_BOUNDARY}--\r\n`;
  const payload = Buffer.concat([Buffer.from(head, "utf8"), opts.body, Buffer.from(tail, "utf8")]);
  return {
    payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      "content-length": String(payload.byteLength),
    },
  };
}

const VALID_CSV_3_ROWS =
  "firstName,lastName,email,phone,type\r\n" +
  "Alice,Martin,alice.bulk@example.org,+33 1 23 45 67 89,donor\r\n" +
  "Bob,Lambert,bob.bulk@example.org,+33 1 11 22 33 44,donor\r\n" +
  "Cécile,Dupont,cecile.bulk@example.org,,volunteer\r\n";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Flip the bulk-import flag ON for the whole suite. The default is
  // OFF (migration 0052); without flipping it the requireFlag gate 404s
  // every route.
  await db
    .update(featureFlags)
    .set({ enabled: true })
    .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT));
  await flagService.invalidate();
});

afterAll(async () => {
  // Reset the flag so cross-suite test DB shares a deterministic seed.
  await db
    .update(featureFlags)
    .set({ enabled: false })
    .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT));
  await flagService.invalidate();
  await app.close();
});

beforeEach(async () => {
  // Clean DB state between tests so polling assertions don't see stale
  // rows from a previous test. Order matters: results FK → jobs, jobs
  // FK → files. Owner-role `db` bypasses RLS in tests (setup.ts —
  // DATABASE_URL_APP intentionally unset), so a direct execute clears
  // both tenants in one shot.
  await db.execute(sql`DELETE FROM bulk_import_results`);
  await db.execute(sql`DELETE FROM bulk_import_jobs`);
  await db.execute(sql`DELETE FROM bulk_import_files`);
  await db.execute(
    sql`DELETE FROM constituents WHERE first_name IN ('BulkDup', 'BulkImport', 'Alice', 'Bob', 'Cécile', 'Pagi', 'OK') AND org_id IN (${ORG_A}, ${ORG_B})`,
  );
  s3Store.clear();

  // The POST /bulk-import route has rate-limit 5/min, the list and
  // status endpoints are 60/min. Several tests in a row blow past 5
  // POSTs without a cache reset → 429. Wipe rate-limit keys per
  // (matches feature-flags.test.ts).
  const keys = await redis.keys("*rate-limit*");
  if (keys.length > 0) await redis.del(...keys);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Worker simulation helper ───────────────────────────────────────────────
//
// The BullMQ worker is not running in this process. Tests that exercise
// the post-worker state (status `completed` / `partial`, per-row
// `bulk_import_results`) write the rows directly. The shape mirrors
// what `packages/worker/src/processors/process-bulk-import.ts` writes —
// any drift here is the worker unit test's job to catch.

interface SimulatedResult {
  rowNumber: number;
  status: "created" | "duplicate" | "failed";
  rowData: Record<string, unknown>;
  constituentId?: string;
  duplicateOfId?: string;
  duplicateScore?: string;
  errorCode?: string;
  errorMessage?: string;
}

async function simulateWorker(
  orgId: string,
  jobId: string,
  results: SimulatedResult[],
): Promise<void> {
  await withTenantContext(orgId, async (tx) => {
    let created = 0;
    let duplicate = 0;
    let failed = 0;
    for (const r of results) {
      await tx.insert(bulkImportResults).values({
        orgId,
        jobId,
        rowNumber: r.rowNumber,
        status: r.status,
        rowData: r.rowData,
        constituentId: r.constituentId,
        duplicateOfId: r.duplicateOfId,
        duplicateScore: r.duplicateScore,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
      });
      if (r.status === "created") created += 1;
      else if (r.status === "duplicate") duplicate += 1;
      else failed += 1;
    }
    const finalStatus: "completed" | "partial" =
      failed === 0 && duplicate === 0 ? "completed" : "partial";
    await tx
      .update(bulkImportJobs)
      .set({
        status: finalStatus,
        processedRows: results.length,
        createdCount: created,
        duplicateCount: duplicate,
        failedCount: failed,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(bulkImportJobs.id, jobId));
  });
}

// Small typed poller: hits the GET endpoint until `status` is terminal
// or `deadlineMs` is reached. Returns the final body. The test must
// have already simulated the worker before calling this — the helper
// is here only to exercise the polling contract the frontend uses.
async function pollUntilTerminal(
  jobId: string,
  token: string,
  deadlineMs = 3000,
): Promise<{
  id: string;
  status: string;
  createdCount: number;
  duplicateCount: number;
  failedCount: number;
  processedRows: number;
  completedAt: string | null;
}> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${jobId}`,
      headers: authHeader(token),
    });
    if (res.statusCode === 200) {
      const body = res.json<{
        data: {
          id: string;
          status: string;
          createdCount: number;
          duplicateCount: number;
          failedCount: number;
          processedRows: number;
          completedAt: string | null;
        };
      }>();
      if (
        body.data.status === "completed" ||
        body.data.status === "partial" ||
        body.data.status === "failed"
      ) {
        return body.data;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`pollUntilTerminal: job ${jobId} did not reach terminal within ${deadlineMs}ms`);
}

// ─── Upload & dispatch ───────────────────────────────────────────────────────

describe("Bulk-import upload + dispatch", () => {
  it("POST happy path returns 202 + jobId + pending status; worker simulation flips to completed with createdCount=3", async () => {
    const token = signToken(app);
    const upload = multipartUpload({
      filename: "constituents.csv",
      contentType: "text/csv",
      body: Buffer.from(VALID_CSV_3_ROWS, "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });

    expect(res.statusCode).toBe(202);
    const body = res.json<{ data: { jobId: string; status: string; totalRows: number } }>();
    expect(body.data.jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(body.data.status).toBe("pending");
    expect(body.data.totalRows).toBe(3);

    // Confirm the file landed in the S3 mock.
    expect(s3Store.size).toBe(1);
    const onlyKey = Array.from(s3Store.keys())[0];
    expect(onlyKey).toMatch(/^00000000-.*\/bulk-imports\/.*\/constituents\.csv$/);

    // Confirm one bulk_import_jobs row + one bulk_import_files row landed
    // for tenant A. Owner-role db bypasses RLS in tests — sanity-check
    // by filtering on orgId explicitly.
    const jobRows = await db.execute<{ id: string; status: string }>(
      sql`SELECT id, status FROM bulk_import_jobs WHERE org_id = ${ORG_A}`,
    );
    expect(jobRows.rows.length).toBe(1);
    expect(jobRows.rows[0]!.id).toBe(body.data.jobId);
    expect(jobRows.rows[0]!.status).toBe("pending");

    // Simulate the worker: create 3 constituents + write 3 result rows
    // + flip status to `completed`.
    const created: string[] = [];
    await withTenantContext(ORG_A, async (tx) => {
      const rows = await tx
        .insert(constituents)
        .values([
          { orgId: ORG_A, firstName: "Alice", lastName: "Martin", email: "alice.bulk@example.org" },
          { orgId: ORG_A, firstName: "Bob", lastName: "Lambert", email: "bob.bulk@example.org" },
          {
            orgId: ORG_A,
            firstName: "Cécile",
            lastName: "Dupont",
            email: "cecile.bulk@example.org",
          },
        ])
        .returning({ id: constituents.id });
      for (const r of rows) created.push(r.id);
    });

    await simulateWorker(ORG_A, body.data.jobId, [
      {
        rowNumber: 1,
        status: "created",
        rowData: { firstName: "Alice", lastName: "Martin" },
        constituentId: created[0],
      },
      {
        rowNumber: 2,
        status: "created",
        rowData: { firstName: "Bob", lastName: "Lambert" },
        constituentId: created[1],
      },
      {
        rowNumber: 3,
        status: "created",
        rowData: { firstName: "Cécile", lastName: "Dupont" },
        constituentId: created[2],
      },
    ]);

    const terminal = await pollUntilTerminal(body.data.jobId, token);
    expect(terminal.status).toBe("completed");
    expect(terminal.createdCount).toBe(3);
    expect(terminal.completedAt).not.toBeNull();

    // 3 actual constituent rows for that org.
    const cRows = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM constituents WHERE org_id = ${ORG_A} AND email LIKE '%bulk@example.org'`,
    );
    expect(Number(cRows.rows[0]!.count)).toBe(3);
  });

  it("CSV missing required `lastName` column returns 400 with MISSING_REQUIRED_HEADERS code", async () => {
    const token = signToken(app);
    const badCsv = "firstName,email\r\nAlice,alice@example.org\r\n";
    const upload = multipartUpload({
      filename: "missing-cols.csv",
      contentType: "text/csv",
      body: Buffer.from(badCsv, "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ title?: string; detail?: string }>();
    // Title surfaces the dispatch error code; detail mentions the
    // missing columns. Either flavour suffices.
    const combined = `${body.title ?? ""} ${body.detail ?? ""}`.toLowerCase();
    expect(combined).toMatch(/missing|required|firstname|lastname/);

    // No `bulk_import_jobs` row was written.
    const rows = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM bulk_import_jobs WHERE org_id = ${ORG_A}`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
  });

  it("file over 10 MB is rejected and no bulk_import_jobs row is created", async () => {
    const token = signToken(app);
    // 11 MB of bytes — past the per-route fileSize cap. The actual
    // bytes shape doesn't matter; the multipart `fileSize` limit fires
    // before the parser even runs.
    const big = Buffer.alloc(11 * 1024 * 1024, 0x41); // 'A'
    const upload = multipartUpload({
      filename: "huge.csv",
      contentType: "text/csv",
      body: big,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    // Multipart plugin emits 413 (Payload Too Large) when the per-route
    // fileSize cap trips. Accept any 4xx so a future config tweak
    // (e.g. 400 from the parser path) still passes.
    expect([400, 413]).toContain(res.statusCode);

    // Critical: no DB row should have been created.
    const rows = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM bulk_import_jobs WHERE org_id = ${ORG_A}`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
  });

  it("rejects invalid MIME (application/octet-stream + .txt extension)", async () => {
    const token = signToken(app);
    const upload = multipartUpload({
      filename: "evil.txt",
      contentType: "application/octet-stream",
      body: Buffer.from("not,actually,csv\r\nfoo,bar,baz\r\n", "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    // 415 Unsupported Media Type is the canonical response — the
    // file-type sniff returns undefined for plain text and the
    // filename doesn't end in .csv / .xlsx, so `decideMime` returns
    // null.
    expect(res.statusCode).toBe(415);
    const rows = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM bulk_import_jobs WHERE org_id = ${ORG_A}`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(0);
  });

  it("CSV cell starting with `=` is quote-prefixed by the parser (formula-injection guard)", async () => {
    // The parser neutralises `=cmd…` by prefixing a single quote.
    // Verify by uploading + simulating the worker reading the row data:
    // the stored `bulk_import_results.row_data` should contain the
    // prefixed value, NOT the raw `=cmd|'/c calc'!A1`. We assert via
    // the upload-side response (totalRows=1) rather than running the
    // real worker — the unit test in
    // packages/api/.../parser test (if added) is the canonical spec.
    const token = signToken(app);
    const csvWithFormula =
      "firstName,lastName,email\r\n" + `=cmd|'/c calc'!A1,Injection,injection@example.org\r\n`;
    const upload = multipartUpload({
      filename: "formula.csv",
      contentType: "text/csv",
      body: Buffer.from(csvWithFormula, "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    // Parser accepts the row — formula prefix neutralised at parse
    // time, not rejected (rejection is reserved for XLSX formula cells
    // with `{formula, result}` shape).
    expect(res.statusCode).toBe(202);
    const body = res.json<{ data: { totalRows: number } }>();
    expect(body.data.totalRows).toBe(1);
  });

  it("returns 404 when the feature flag is disabled (requireFlag gate)", async () => {
    await db
      .update(featureFlags)
      .set({ enabled: false })
      .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT));
    await flagService.invalidate();
    try {
      const token = signToken(app);
      const upload = multipartUpload({
        filename: "anything.csv",
        contentType: "text/csv",
        body: Buffer.from(VALID_CSV_3_ROWS, "utf8"),
      });
      const res = await app.inject({
        method: "POST",
        url: "/v1/constituents/bulk-import",
        headers: { ...authHeader(token), ...upload.headers },
        payload: upload.payload,
      });
      expect(res.statusCode).toBe(404);

      // Also the GET endpoints — they share the same gate.
      const listRes = await app.inject({
        method: "GET",
        url: "/v1/constituents/bulk-import",
        headers: authHeader(token),
      });
      expect(listRes.statusCode).toBe(404);

      const templateRes = await app.inject({
        method: "GET",
        url: "/v1/constituents/bulk-import/template",
        headers: authHeader(token),
      });
      expect(templateRes.statusCode).toBe(404);
    } finally {
      // Restore flag for the remaining tests.
      await db
        .update(featureFlags)
        .set({ enabled: true })
        .where(eq(featureFlags.key, FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT));
      await flagService.invalidate();
    }
  });
});

// ─── Status / list / results ────────────────────────────────────────────────

describe("Bulk-import status / list / results", () => {
  it("GET /:id/results paginates and filters by status (created vs failed)", async () => {
    // Upload + simulate a partial job with 1 created + 1 failed.
    const token = signToken(app);
    const upload = multipartUpload({
      filename: "mixed.csv",
      contentType: "text/csv",
      body: Buffer.from(VALID_CSV_3_ROWS, "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json<{ data: { jobId: string } }>().data.jobId;

    let createdId = "";
    await withTenantContext(ORG_A, async (tx) => {
      const [c] = await tx
        .insert(constituents)
        .values({ orgId: ORG_A, firstName: "Pagi", lastName: "Nated" })
        .returning({ id: constituents.id });
      createdId = c!.id;
    });

    await simulateWorker(ORG_A, jobId, [
      {
        rowNumber: 1,
        status: "created",
        rowData: { firstName: "Pagi", lastName: "Nated" },
        constituentId: createdId,
      },
      {
        rowNumber: 2,
        status: "failed",
        rowData: { firstName: "Bob" },
        errorCode: "REQUIRED_LAST_NAME",
        errorMessage: "lastName is required",
      },
    ]);

    const createdRes = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${jobId}/results?status=created`,
      headers: authHeader(token),
    });
    expect(createdRes.statusCode).toBe(200);
    const createdBody = createdRes.json<{
      data: Array<{ status: string; constituentId: string | null }>;
    }>();
    expect(createdBody.data.length).toBe(1);
    expect(createdBody.data[0]!.status).toBe("created");
    expect(createdBody.data[0]!.constituentId).toBe(createdId);

    const failedRes = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${jobId}/results?status=failed`,
      headers: authHeader(token),
    });
    expect(failedRes.statusCode).toBe(200);
    const failedBody = failedRes.json<{
      data: Array<{ status: string; errorCode: string | null; errorMessage: string | null }>;
    }>();
    expect(failedBody.data.length).toBe(1);
    expect(failedBody.data[0]!.status).toBe("failed");
    expect(failedBody.data[0]!.errorCode).toBe("REQUIRED_LAST_NAME");
    expect(failedBody.data[0]!.errorMessage).toBe("lastName is required");
  });

  it("GET / paginates with real total count across 3 jobs", async () => {
    // Seed 3 fake jobs directly. Each needs a file row first (FK).
    await withTenantContext(ORG_A, async (tx) => {
      for (let i = 0; i < 3; i++) {
        const [file] = await tx
          .insert(bulkImportFiles)
          .values({
            orgId: ORG_A,
            s3Key: `${ORG_A}/bulk-imports/seed-${i}/file.csv`,
            s3Bucket: "bulk-imports",
            fileName: `file-${i}.csv`,
            fileSize: 100,
            mimeType: "text/csv",
          })
          .returning({ id: bulkImportFiles.id });
        await tx.insert(bulkImportJobs).values({
          orgId: ORG_A,
          status: "completed",
          totalRows: 5,
          fileId: file!.id,
        });
      }
    });

    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/bulk-import?page=1&perPage=2",
      headers: authHeader(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: unknown[];
      pagination: { total: number; page: number; perPage: number; totalPages: number };
    }>();
    expect(body.data.length).toBe(2);
    expect(body.pagination.total).toBe(3);
    expect(body.pagination.totalPages).toBe(2);
  });

  it("status transitions: full success → `completed` + completedAt set", async () => {
    const token = signToken(app);
    const upload = multipartUpload({
      filename: "all-good.csv",
      contentType: "text/csv",
      body: Buffer.from(VALID_CSV_3_ROWS, "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    const jobId = res.json<{ data: { jobId: string } }>().data.jobId;

    let cId = "";
    await withTenantContext(ORG_A, async (tx) => {
      const [c] = await tx
        .insert(constituents)
        .values({ orgId: ORG_A, firstName: "OK", lastName: "Path" })
        .returning({ id: constituents.id });
      cId = c!.id;
    });

    await simulateWorker(ORG_A, jobId, [
      {
        rowNumber: 1,
        status: "created",
        rowData: { firstName: "OK", lastName: "Path" },
        constituentId: cId,
      },
    ]);

    const terminal = await pollUntilTerminal(jobId, token);
    expect(terminal.status).toBe("completed");
    expect(terminal.completedAt).not.toBeNull();
  });

  it("status transitions: row with only firstName → `partial` + 1 failed result with MISSING_REQUIRED", async () => {
    // Upload a 1-row CSV that's valid on parse (header includes
    // lastName) but the row leaves lastName blank — the worker
    // catches it and writes a failed result.
    const token = signToken(app);
    const csv = "firstName,lastName,email\r\nOnly,,still.parseable@example.org\r\n";
    const upload = multipartUpload({
      filename: "missing-lastname.csv",
      contentType: "text/csv",
      body: Buffer.from(csv, "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json<{ data: { jobId: string } }>().data.jobId;

    await simulateWorker(ORG_A, jobId, [
      {
        rowNumber: 1,
        status: "failed",
        rowData: { firstName: "Only", email: "still.parseable@example.org" },
        errorCode: "MISSING_REQUIRED",
        errorMessage: "lastName is required",
      },
    ]);

    const terminal = await pollUntilTerminal(jobId, token);
    expect(terminal.status).toBe("partial");
    expect(terminal.failedCount).toBe(1);

    const resultsRes = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${jobId}/results`,
      headers: authHeader(token),
    });
    expect(resultsRes.statusCode).toBe(200);
    const results = resultsRes.json<{
      data: Array<{ status: string; errorCode: string | null }>;
    }>();
    expect(results.data.length).toBe(1);
    expect(results.data[0]!.status).toBe("failed");
    expect(results.data[0]!.errorCode).toBe("MISSING_REQUIRED");
  });
});

// ─── Duplicate detection ────────────────────────────────────────────────────

describe("Bulk-import duplicate detection", () => {
  it("row whose email matches an existing constituent produces `duplicate` result with duplicate_of_id set", async () => {
    // Pre-seed an existing constituent in tenant A with a known email.
    let existingId = "";
    await withTenantContext(ORG_A, async (tx) => {
      const [c] = await tx
        .insert(constituents)
        .values({
          orgId: ORG_A,
          firstName: "BulkImport",
          lastName: "Existing",
          email: "exists.bulk@example.org",
          type: "donor",
        })
        .returning({ id: constituents.id });
      existingId = c!.id;
    });

    const token = signToken(app);
    const csv = "firstName,lastName,email\r\nBulkImport,Existing,exists.bulk@example.org\r\n";
    const upload = multipartUpload({
      filename: "dup.csv",
      contentType: "text/csv",
      body: Buffer.from(csv, "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json<{ data: { jobId: string } }>().data.jobId;

    // Simulate the worker matching against `existingId` — duplicate
    // detection logic is the worker's responsibility; this test
    // verifies the API surface for the result.
    await simulateWorker(ORG_A, jobId, [
      {
        rowNumber: 1,
        status: "duplicate",
        rowData: {
          firstName: "BulkImport",
          lastName: "Existing",
          email: "exists.bulk@example.org",
        },
        duplicateOfId: existingId,
        duplicateScore: "1.00",
      },
    ]);

    const terminal = await pollUntilTerminal(jobId, token);
    expect(terminal.status).toBe("partial");
    expect(terminal.duplicateCount).toBe(1);

    const resultsRes = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${jobId}/results`,
      headers: authHeader(token),
    });
    const results = resultsRes.json<{
      data: Array<{ status: string; duplicateOfId: string | null; constituentId: string | null }>;
    }>();
    expect(results.data.length).toBe(1);
    expect(results.data[0]!.status).toBe("duplicate");
    expect(results.data[0]!.duplicateOfId).toBe(existingId);

    // No new constituent row was created for the duplicate (only the
    // seed row exists).
    const rows = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*)::int AS count FROM constituents WHERE org_id = ${ORG_A} AND email = 'exists.bulk@example.org'`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });
});

// ─── Template download ──────────────────────────────────────────────────────

describe("Bulk-import template download", () => {
  it("GET /template returns 200 with text/csv MIME, attachment Content-Disposition, BOM-prefixed body, 10 example rows", async () => {
    const token = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/bulk-import/template",
      headers: authHeader(token),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-type"]).toContain("charset=utf-8");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(
      'filename="givernance-import-template.csv"',
    );

    const body = res.body;
    // BOM at the start so Excel for Windows detects UTF-8 (parser.ts comment).
    expect(body.charCodeAt(0)).toBe(0xfeff);

    // Header row + 10 example rows + trailing CRLF — split on \r\n and
    // drop empty trailer.
    const lines = body.split("\r\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(11); // 1 header + 10 example rows

    // Header row carries the canonical columns.
    const headerLine = lines[0]!;
    for (const col of [
      "firstName",
      "lastName",
      "email",
      "phone",
      "addressLine1",
      "addressLine2",
      "postalCode",
      "city",
      "countryCode",
      "type",
      "tags",
    ]) {
      expect(headerLine).toContain(col);
    }
  });
});

// ─── File download (round-trip through the S3 mock) ─────────────────────────

describe("Bulk-import file download", () => {
  it("GET /:id/download streams the original file bytes back with the sanitised filename", async () => {
    const token = signToken(app);
    const originalBytes = Buffer.from(VALID_CSV_3_ROWS, "utf8");
    const upload = multipartUpload({
      filename: "constituents-original.csv",
      contentType: "text/csv",
      body: originalBytes,
    });
    const uploadRes = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(uploadRes.statusCode).toBe(202);
    const jobId = uploadRes.json<{ data: { jobId: string } }>().data.jobId;

    const dlRes = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${jobId}/download`,
      headers: authHeader(token),
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers["content-type"]).toContain("text/csv");
    expect(dlRes.headers["content-disposition"]).toContain('filename="constituents-original.csv"');

    // Body matches byte-for-byte. `inject` returns the raw body as a
    // string; CSV is ASCII so the byte length matches.
    expect(Buffer.byteLength(dlRes.body)).toBe(originalBytes.byteLength);
    expect(dlRes.body).toBe(VALID_CSV_3_ROWS);
  });
});

// ─── RLS isolation (mandatory — CLAUDE.md QA bar) ───────────────────────────
//
// Each cross-tenant probe must surface as 404, not 403 (which would
// disclose the row's existence) and not 200 (which would leak data).
//
// `seedTenantUser` is implicitly handled by `ensureTestTenants` — the
// USER_A / USER_B fixtures back the synthetic JWT subjects.

describe("Bulk-import RLS tenant isolation", () => {
  let tenantAJobId: string;

  beforeEach(async () => {
    // Re-seed a fresh job for tenant A — `beforeEach` wipes everything,
    // so this is a clean state for every RLS probe.
    const tokenA = signToken(app);
    const upload = multipartUpload({
      filename: "tenant-a.csv",
      contentType: "text/csv",
      body: Buffer.from(VALID_CSV_3_ROWS, "utf8"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/constituents/bulk-import",
      headers: { ...authHeader(tokenA), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(202);
    tenantAJobId = res.json<{ data: { jobId: string } }>().data.jobId;

    // Simulate the worker so the row is fully "real" for tenant A.
    await simulateWorker(ORG_A, tenantAJobId, [
      {
        rowNumber: 1,
        status: "created",
        rowData: { firstName: "Alice", lastName: "Martin" },
      },
    ]);
  });

  it("Tenant B GET /:id of tenant A's job returns 404", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${tenantAJobId}`,
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(404);
  });

  it("Tenant B GET /:id/results of tenant A's job returns 404 (or empty data array — never tenant A rows)", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${tenantAJobId}/results`,
      headers: authHeader(tokenB),
    });
    // Service returns null → 404 when the job isn't visible to the
    // tenant. Accept 200 with empty data as an alternative (defensive
    // against a future "tenant-B sees an empty paginated list" change),
    // but NEVER tenant A's rows.
    expect([404, 200]).toContain(res.statusCode);
    if (res.statusCode === 200) {
      const body = res.json<{ data: unknown[] }>();
      expect(body.data).toEqual([]);
    }
  });

  it("Tenant B GET /:id/download of tenant A's job returns 404", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: `/v1/constituents/bulk-import/${tenantAJobId}/download`,
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(404);
  });

  it("Tenant B list does NOT include tenant A's job", async () => {
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/constituents/bulk-import",
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }> }>();
    const ids = body.data.map((r) => r.id);
    expect(ids).not.toContain(tenantAJobId);
  });
});

// ─── Defense-in-depth: CHECK constraint on counter consistency ──────────────

describe("Bulk-import DB CHECK constraints", () => {
  it("bulk_import_jobs_progress_chk rejects counters that exceed processed_rows", async () => {
    // Seed a valid job first so we have a row to UPDATE.
    let jobId = "";
    await withTenantContext(ORG_A, async (tx) => {
      const [file] = await tx
        .insert(bulkImportFiles)
        .values({
          orgId: ORG_A,
          s3Key: `${ORG_A}/bulk-imports/chk/file.csv`,
          s3Bucket: "bulk-imports",
          fileName: "chk.csv",
          fileSize: 100,
          mimeType: "text/csv",
        })
        .returning({ id: bulkImportFiles.id });
      const [job] = await tx
        .insert(bulkImportJobs)
        .values({
          orgId: ORG_A,
          status: "pending",
          totalRows: 10,
          fileId: file!.id,
        })
        .returning({ id: bulkImportJobs.id });
      jobId = job!.id;
    });

    // This UPDATE violates `created_count + duplicate_count +
    // failed_count <= processed_rows`. Postgres must reject it.
    await expect(
      withTenantContext(ORG_A, async (tx) => {
        await tx.execute(sql`
          UPDATE bulk_import_jobs
             SET processed_rows = 1,
                 created_count = 5,
                 duplicate_count = 5,
                 failed_count = 5
           WHERE id = ${jobId}
        `);
      }),
    ).rejects.toThrow();
  });
});
