/**
 * Branding endpoint integration tests — Epic #286.
 *
 * Coverage targets (issue spec §L):
 *   - RLS isolation: org A uploads, org B cannot see it.
 *   - SVG with `<script>` rejected at the sanitiser.
 *   - Oversized file rejected (multipart `fileSize` cap).
 *   - Magic-byte spoofing rejected (PNG header on JS bytes).
 *   - Non-org-admin role gets 403.
 *
 * The worker pipeline runs out-of-process — these tests don't drive
 * the BullMQ worker; they verify the API contract + DB row state +
 * outbox enqueue. Worker-side correctness lives in
 * `packages/worker/src/services/branding-pipeline.test.ts`.
 */

import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "../../server.js";
import {
  authHeader,
  ensureTestTenants,
  ORG_A,
  ORG_B,
  signToken,
  signTokenB,
} from "../../tests/helpers/auth.js";
import { db } from "../../tests/helpers/db.js";

// CI has no MinIO service; the branding upload path does a real PutObject.
// Stub the bucket-write helper so the route succeeds without the network
// hop. Variant generation + Keycloak sync run in the worker (separately
// covered) — these tests only assert the API contract + DB + outbox shape.
vi.mock("../../lib/s3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/s3.js")>();
  return {
    ...actual,
    putBrandingObject: vi.fn().mockResolvedValue(undefined),
    deleteBrandingPrefix: vi.fn().mockResolvedValue(undefined),
  };
});

let app: FastifyInstance;

// 1×1 transparent PNG — minimal valid raster for size-cap + RLS tests.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const MULTIPART_BOUNDARY = "----GivernanceTestBoundary";

/**
 * Build a multipart/form-data body with a single `file` field.
 * Returns Buffer + headers ready for `app.inject()`.
 */
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

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();

  // Clear branding state for a deterministic run. The migration adds the
  // table with cascade-on-tenant-delete so a re-running CI environment
  // shouldn't have leftovers, but the local-dev DB might.
  await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id IN (${ORG_A}, ${ORG_B})`);
  await db.execute(sql`DELETE FROM org_branding_assets WHERE org_id IN (${ORG_A}, ${ORG_B})`);
});

afterAll(async () => {
  await app.close();
});

describe("Branding org-logo upload", () => {
  it("rejects non-org-admin with 403", async () => {
    // signToken default is `role: "org_admin"`; override to `user`.
    const token = signToken(app, { role: "user" });
    const upload = multipartUpload({
      filename: "logo.png",
      contentType: "image/png",
      body: TINY_PNG,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/branding/org-logo",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects unauthenticated with 401", async () => {
    const upload = multipartUpload({
      filename: "logo.png",
      contentType: "image/png",
      body: TINY_PNG,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/branding/org-logo",
      headers: upload.headers,
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects magic-byte spoofing (text body claiming image/png)", async () => {
    const token = signToken(app);
    const fakeBody = Buffer.from("alert('xss')", "utf8");
    const upload = multipartUpload({
      filename: "trojan.png",
      contentType: "image/png",
      body: fakeBody,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/branding/org-logo",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects SVG containing <script>", async () => {
    const token = signToken(app);
    const malicious = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      "utf8",
    );
    const upload = multipartUpload({
      filename: "logo.svg",
      contentType: "image/svg+xml",
      body: malicious,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/branding/org-logo",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ reason?: string }>();
    expect(body.reason).toBe("contains_script");
  });

  it("rejects SVG with onclick handler", async () => {
    const token = signToken(app);
    const malicious = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)" /></svg>`,
      "utf8",
    );
    const upload = multipartUpload({
      filename: "logo.svg",
      contentType: "image/svg+xml",
      body: malicious,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/branding/org-logo",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ reason?: string }>();
    expect(body.reason).toBe("contains_event_handler");
  });

  it("rejects oversized raster (>5 MB)", async () => {
    const token = signToken(app);
    // 6 MB random buffer; doesn't matter that it's not a real image —
    // multipart `fileSize` limit fires before MIME detection.
    const big = Buffer.alloc(6 * 1024 * 1024, 0xff);
    const upload = multipartUpload({
      filename: "huge.png",
      contentType: "image/png",
      body: big,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/branding/org-logo",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(413);
  });

  it("accepts a valid PNG and returns a pending asset", async () => {
    // Wipe any prior state for org A so this test can assert on a clean
    // GET afterwards.
    await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id = ${ORG_A}`);
    await db.execute(sql`DELETE FROM org_branding_assets WHERE org_id = ${ORG_A}`);

    const token = signToken(app);
    const upload = multipartUpload({
      filename: "logo.png",
      contentType: "image/png",
      body: TINY_PNG,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/branding/org-logo",
      headers: { ...authHeader(token), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: {
        id: string;
        status: string;
        originalUrl: string;
        originalContentType: string;
      };
    }>();
    expect(body.data.status).toBe("pending");
    expect(body.data.originalContentType).toBe("image/png");
    expect(body.data.originalUrl).toMatch(/\/branding\//);

    // Outbox events were enqueued. Only `branding.process_asset` —
    // `branding.activate_logo` is now emitted by the worker AFTER the
    // pipeline flips the row to `status='ready'` (PR #287 review,
    // blocker 3) so ordering is causal at the DB level.
    const outbox = await db.execute<{ type: string }>(
      sql`SELECT type FROM outbox_events WHERE tenant_id = ${ORG_A} AND payload->>'assetId' = ${body.data.id}`,
    );
    const types = (outbox.rows ?? []).map((r) => r.type).sort();
    expect(types).toContain("branding.process_asset");
    expect(types).not.toContain("branding.activate_logo");
  });

  it("GET /v1/branding/org-logo enforces RLS isolation between tenants", async () => {
    // Org A upload from the previous test left a row; org B should see null.
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/branding/org-logo",
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown }>();
    expect(body.data).toBeNull();
  });

  it("RLS isolation is symmetric: org B uploads do not leak to org A", async () => {
    // Mirror of the previous test (PR #287 review, minor 8). The first
    // direction caught a hypothetical "tenant A's row visible to tenant
    // B" leak; this case catches the symmetric "tenant B uploads, but
    // tenant A's GET reads B's row" leak. Both are necessary because
    // a typo in the RLS predicate (`org_id = ANY(...)` vs.
    // `org_id = current_org()`) could fail in only one direction.
    await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id = ${ORG_A}`);
    await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id = ${ORG_B}`);
    await db.execute(sql`DELETE FROM org_branding_assets WHERE org_id = ${ORG_A}`);
    await db.execute(sql`DELETE FROM org_branding_assets WHERE org_id = ${ORG_B}`);

    const tokenB = signTokenB(app);
    const upload = multipartUpload({
      filename: "logo.png",
      contentType: "image/png",
      body: TINY_PNG,
    });
    const uploadRes = await app.inject({
      method: "POST",
      url: "/v1/branding/org-logo",
      headers: { ...authHeader(tokenB), ...upload.headers },
      payload: upload.payload,
    });
    expect(uploadRes.statusCode).toBe(201);

    // Org A's GET must NOT see org B's row — RLS predicate must
    // exclude the row at the SQL level, not just at the application
    // serialisation layer.
    const tokenA = signToken(app);
    const res = await app.inject({
      method: "GET",
      url: "/v1/branding/org-logo",
      headers: authHeader(tokenA),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown }>();
    expect(body.data).toBeNull();
  });

  it("DELETE /v1/branding/org-logo is idempotent when no logo set", async () => {
    // Ensure a clean state for org B.
    await db.execute(sql`UPDATE tenants SET logo_asset_id = NULL WHERE id = ${ORG_B}`);
    const tokenB = signTokenB(app);
    const res = await app.inject({
      method: "DELETE",
      url: "/v1/branding/org-logo",
      headers: authHeader(tokenB),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { deleted: boolean } }>();
    expect(body.data.deleted).toBe(false);
  });
});
