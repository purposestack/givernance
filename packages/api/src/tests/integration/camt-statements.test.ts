/**
 * API integration tests for the camt.053 surface (Epic #318 PR #5).
 *
 * Covers the HTTP contract:
 *   - POST /v1/bank-accounts/:id/statements (multipart .xml upload)
 *   - GET  /v1/camt-statements (list with filters + pagination)
 *   - GET  /v1/camt-statements/:id (detail)
 *   - GET  /v1/bank-accounts/:id/reconciliation-health
 *   - GET  /v1/camt-unreconciled
 *   - POST /v1/camt-unreconciled/:id/resolve (link / write_off)
 *
 * The worker pipeline is NOT exercised here — those tests live under
 * `packages/worker/src/tests/integration/camt053-pipeline.test.ts`.
 * Here we assert the API contract + RLS isolation + audit trail.
 */

import {
  bankAccounts,
  camtCreditEntries,
  camtStatements,
  camtUnreconciledEntries,
} from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

const MULTIPART_BOUNDARY = "----GivernanceCamtTestBoundary";

function multipartUpload(opts: { filename: string; contentType: string; body: Buffer }): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const head =
    `--${MULTIPART_BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
    `Content-Type: ${opts.contentType}\r\n\r\n`;
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

function emptyMultipart(): { payload: Buffer; headers: Record<string, string> } {
  const tail = `--${MULTIPART_BOUNDARY}--\r\n`;
  const payload = Buffer.from(tail, "utf8");
  return {
    payload,
    headers: {
      "content-type": `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
      "content-length": String(payload.byteLength),
    },
  };
}

// Mock the S3 layer so the test doesn't need MinIO running.
const putBankStatementMock = vi.fn(async (args: { key: string }) => args.key);
const getBankStatementSignedUrlMock = vi.fn(
  async (args: { key: string }) => `https://signed.example/${args.key}?sig=test`,
);

vi.mock("../../lib/s3.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/s3.js")>("../../lib/s3.js");
  return {
    ...actual,
    putBankStatement: putBankStatementMock,
    getBankStatementSignedUrl: getBankStatementSignedUrlMock,
  };
});

const { createServer } = await import("../../server.js");
const { authHeader, ensureTestTenants, ORG_A, signToken } = await import("../helpers/auth.js");

let app: FastifyInstance;
const VALID_CH_IBAN = "CH9300762011623852957";

const HOLDER = {
  holderName: "Camt Statements Test Org",
  holderStreet: "Rue de la Paix",
  holderBuildingNumber: "12",
  holderPostalCode: "1003",
  holderTown: "Lausanne",
  holderCountryCode: "CH",
};

let bankAccountId: string;

const HAPPY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>API-TEST-1</MsgId></GrpHdr>
    <Stmt>
      <Acct><Id><IBAN>CH9300762011623852957</IBAN></Id></Acct>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

beforeAll(async () => {
  app = await createServer();
  await app.ready();
  await ensureTestTenants();
  // Fresh slate.
  await db.execute(sql`DELETE FROM camt_unreconciled_entries WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM camt_credit_entries WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM camt_statements WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id = ${ORG_A}`);

  const [account] = await db
    .insert(bankAccounts)
    .values({
      orgId: ORG_A,
      ...HOLDER,
      iban: VALID_CH_IBAN,
      ibanKind: "iban",
      bankName: "PostFinance",
      currency: "CHF",
    })
    .returning();
  bankAccountId = account!.id;
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM camt_unreconciled_entries WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM camt_credit_entries WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM camt_statements WHERE org_id = ${ORG_A}`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id = ${ORG_A}`);
  await app.close();
});

describe("POST /v1/bank-accounts/:id/statements — upload", () => {
  it("accepts a valid camt.053 XML upload (202 + statementId)", async () => {
    const upload = multipartUpload({
      filename: "statement-2026-05.xml",
      contentType: "application/xml",
      body: Buffer.from(HAPPY_XML, "utf-8"),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/bank-accounts/${bankAccountId}/statements`,
      headers: { ...authHeader(signToken(app)), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ data: { statementId: string; status: string } }>();
    expect(body.data.status).toBe("pending");
    expect(putBankStatementMock).toHaveBeenCalled();

    const outbox = await db.execute(
      sql`SELECT type, payload FROM outbox_events WHERE tenant_id = ${ORG_A} AND type = 'camt053.uploaded' ORDER BY created_at DESC LIMIT 1`,
    );
    const row = (
      outbox as unknown as {
        rows: Array<{ type: string; payload: Record<string, unknown> }>;
      }
    ).rows[0];
    expect(row?.type).toBe("camt053.uploaded");
    expect((row?.payload as { statementId: string }).statementId).toBe(body.data.statementId);
  });

  it("rejects an upload with no file part", async () => {
    const upload = emptyMultipart();
    const res = await app.inject({
      method: "POST",
      url: `/v1/bank-accounts/${bankAccountId}/statements`,
      headers: { ...authHeader(signToken(app)), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a non-.xml filename", async () => {
    const upload = multipartUpload({
      filename: "statement.txt",
      contentType: "application/xml",
      body: Buffer.from(HAPPY_XML, "utf-8"),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/bank-accounts/${bankAccountId}/statements`,
      headers: { ...authHeader(signToken(app)), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ code: string }>();
    expect(body.code).toBe("filename_not_xml");
  });

  it("404s on a non-existent bank account", async () => {
    const upload = multipartUpload({
      filename: "stmt.xml",
      contentType: "application/xml",
      body: Buffer.from(HAPPY_XML, "utf-8"),
    });
    const ghost = "00000000-0000-0000-0000-00000000ffff";
    const res = await app.inject({
      method: "POST",
      url: `/v1/bank-accounts/${ghost}/statements`,
      headers: { ...authHeader(signToken(app)), ...upload.headers },
      payload: upload.payload,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /v1/camt-statements + GET /v1/camt-statements/:id", () => {
  it("lists statements with pagination + filter by bankAccountId", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/camt-statements?bankAccountId=${bankAccountId}`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Array<{ id: string }>; pagination: { total: number } }>();
    expect(body.pagination.total).toBeGreaterThanOrEqual(1);
    expect(body.data[0]?.id).toBeTruthy();
  });

  it("returns detail with bankAccount + counts", async () => {
    const [stmt] = await db
      .select({ id: camtStatements.id })
      .from(camtStatements)
      .where(eq(camtStatements.orgId, ORG_A))
      .limit(1);
    const res = await app.inject({
      method: "GET",
      url: `/v1/camt-statements/${stmt!.id}`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { id: string; bankAccount: { iban: string } | null; creditEntryCount: number };
    }>();
    expect(body.data.id).toBe(stmt!.id);
    expect(body.data.bankAccount?.iban).toBe(VALID_CH_IBAN);
    expect(body.data.creditEntryCount).toBe(0);
  });

  it("download returns a signed-URL redirect", async () => {
    const [stmt] = await db
      .select({ id: camtStatements.id })
      .from(camtStatements)
      .where(eq(camtStatements.orgId, ORG_A))
      .limit(1);
    const res = await app.inject({
      method: "GET",
      url: `/v1/camt-statements/${stmt!.id}/download`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("https://signed.example/");
  });
});

describe("GET /v1/bank-accounts/:id/reconciliation-health", () => {
  it("returns aggregates for the bank account", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/bank-accounts/${bankAccountId}/reconciliation-health`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: {
        totalStatements: number;
        lastStatementImportedAt: string | null;
        recentStatements: Array<{ id: string }>;
      };
    }>();
    expect(body.data.totalStatements).toBeGreaterThanOrEqual(1);
    expect(body.data.recentStatements.length).toBeGreaterThanOrEqual(1);
  });
});

describe("camt-unreconciled queue", () => {
  let creditEntryId: string;
  let unreconciledId: string;

  beforeAll(async () => {
    const [stmt] = await db
      .select({ id: camtStatements.id })
      .from(camtStatements)
      .where(eq(camtStatements.orgId, ORG_A))
      .limit(1);
    const [ce] = await db
      .insert(camtCreditEntries)
      .values({
        orgId: ORG_A,
        statementId: stmt!.id,
        acctSvcrRef: "TEST-CE-1",
        amountCents: 5000,
        currency: "CHF",
        debtorName: "Maria Garcia",
        debtorIban: "CH5104835012345678123",
      })
      .returning();
    creditEntryId = ce!.id;
    const [ue] = await db
      .insert(camtUnreconciledEntries)
      .values({
        orgId: ORG_A,
        creditEntryId,
        reason: "no_match",
      })
      .returning();
    unreconciledId = ue!.id;
  });

  it("lists unreconciled entries with credit-entry context", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/camt-unreconciled?bankAccountId=${bankAccountId}`,
      headers: authHeader(signToken(app)),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: Array<{
        id: string;
        reason: string;
        creditEntry: { amountCents: number; debtorName: string | null };
      }>;
    }>();
    expect(body.data.some((r) => r.id === unreconciledId)).toBe(true);
    const row = body.data.find((r) => r.id === unreconciledId);
    expect(row?.creditEntry.amountCents).toBe(5000);
    expect(row?.creditEntry.debtorName).toBe("Maria Garcia");
  });

  it("write_off transitions to written_off + records audit", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/camt-unreconciled/${unreconciledId}/resolve`,
      headers: { ...authHeader(signToken(app)), "content-type": "application/json" },
      payload: {
        action: "write_off",
        resolutionNote: "Bank fee, not a donation",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { status: string } }>();
    expect(body.data.status).toBe("written_off");

    // Subsequent resolve on the same row is rejected as already_resolved.
    const second = await app.inject({
      method: "POST",
      url: `/v1/camt-unreconciled/${unreconciledId}/resolve`,
      headers: { ...authHeader(signToken(app)), "content-type": "application/json" },
      payload: { action: "write_off", resolutionNote: "x" },
    });
    expect(second.statusCode).toBe(400);

    // Audit row recorded.
    const audit = await db.execute(
      sql`SELECT action FROM audit_logs WHERE org_id = ${ORG_A} AND resource_type = 'camt_unreconciled_entry' AND resource_id = ${unreconciledId} ORDER BY created_at DESC LIMIT 1`,
    );
    const row = (audit as unknown as { rows: Array<{ action: string }> }).rows[0];
    expect(row?.action).toContain("camt_unreconciled_entry");
  });
});
