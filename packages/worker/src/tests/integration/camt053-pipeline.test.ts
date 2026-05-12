/**
 * Worker integration tests for the camt.053 import + reconcile pipeline
 * (Epic #318 PR #5).
 *
 * The HTTP-side upload is covered by API integration tests; this file
 * exercises the two worker processors directly with the storage layer
 * mocked. The fixture XMLs from `tests/fixtures/camt053/` are rewritten
 * with valid QRR references at runtime so the reconciler can match
 * against `swiss_qr_references` rows we insert in `beforeAll`.
 *
 * Coverage:
 *   - Import happy path (parse, persist, idempotent retry)
 *   - Reconcile personalized (ref → constituent → donation)
 *   - Reconcile door-drop (find-or-create constituent via §5.5 matrix)
 *   - Enrichment on second import (IBAN match, fields filled)
 *   - Foreign-IBAN rejection
 *   - Invalid-ref → unreconciled
 *   - Re-import idempotency (statement-level msg-id dedup)
 *   - identity_completeness derivation
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bankAccounts,
  campaigns,
  camtCreditEntries,
  camtStatements,
  camtUnreconciledEntries,
  constituents,
  donations,
  swissQrReferences,
} from "@givernance/shared/schema";
import { computeQrr } from "@givernance/shared/validators";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";

// ── Mock S3 BEFORE importing the processor (vi.mock is hoisted). ─────
// `getBankStatement` returns the fixture XML keyed off the s3 path the
// upload service wrote. We populate the map per-test.
const fakeStorage = new Map<string, Buffer>();
const moveRejectedMock = vi.fn(async () => {});

vi.mock("../../lib/s3.js", () => ({
  getBankStatement: vi.fn(async (key: string) => fakeStorage.get(key) ?? null),
  bankStatementRejectedKey: ({
    orgId,
    year,
    month,
    uuid,
  }: {
    orgId: string;
    year: number;
    month: number;
    uuid: string;
  }) => `${orgId}/camt053/rejected/${year}/${String(month).padStart(2, "0")}/${uuid}.xml`,
  moveBankStatementToRejected: moveRejectedMock,
}));

const { processCamt053Import } = await import("../../processors/camt053-import.js");
const { processCamt053Reconcile } = await import("../../processors/camt053-reconcile.js");

// ── Fixtures + paths. ──────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures", "camt053");

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), "utf-8");
}

/**
 * Mint a valid QRR with the given numeric prefix (left-padded with
 * zeros to 26 digits before the check). Returns the 27-digit QRR.
 */
function mintQrr(seed: string): string {
  const body = seed.padStart(26, "0").slice(-26);
  return computeQrr(body);
}

const ORG_ID = "00000000-0000-0000-0000-00000000c053";
const BANK_ACCT_IBAN = "CH9300762011623852957";

let bankAccountId: string;
let campaignId: string;
let constituentPersonalisedId: string;
let qrrPersonalised: string;
let qrrDoorDrop: string;
let qrrInvalid: string; // intentionally fails mod-10

function makeMockJob(data: Record<string, unknown>) {
  return {
    data,
    id: `test-camt-job-${Math.random().toString(36).slice(2, 10)}`,
    attemptsMade: 0,
    log: vi.fn(),
  } as never;
}

beforeAll(async () => {
  // Tenant + bank account + campaign + a personalised constituent + two
  // swiss_qr_references rows (one with constituent, one door-drop).
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_ID}, 'Camt Pipeline Org', 'camt-pipeline') ON CONFLICT (id) DO NOTHING`,
  );
  // Clean any prior runs for this org so test re-runs don't trip uniques.
  await db.execute(sql`DELETE FROM camt_unreconciled_entries WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM camt_credit_entries WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM camt_statements WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM swiss_qr_references WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaign_postal_exports WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id = ${ORG_ID}`);

  const [account] = await db
    .insert(bankAccounts)
    .values({
      orgId: ORG_ID,
      holderName: "Camt Org",
      holderStreet: "Hauptstrasse",
      holderPostalCode: "8001",
      holderTown: "Zurich",
      holderCountryCode: "CH",
      iban: BANK_ACCT_IBAN,
      ibanKind: "iban",
      bankName: "PostFinance",
      currency: "CHF",
    })
    .returning();
  bankAccountId = account!.id;

  const [campaign] = await db
    .insert(campaigns)
    .values({
      orgId: ORG_ID,
      name: "Camt Test Campaign",
      type: "nominative_postal",
      status: "active",
      bankAccountId,
    })
    .returning();
  campaignId = campaign!.id;

  const [constituent] = await db
    .insert(constituents)
    .values({
      orgId: ORG_ID,
      firstName: "Jean",
      lastName: "Dupont",
      type: "donor",
    })
    .returning();
  constituentPersonalisedId = constituent!.id;

  // Insert a postal export row (the swiss_qr_references FK requires it).
  const exportResult = await db.execute(
    sql`INSERT INTO campaign_postal_exports (org_id, campaign_id, mode, status, total_count, progress_count)
        VALUES (${ORG_ID}, ${campaignId}, 'personalized', 'completed', 1, 1)
        RETURNING id`,
  );
  const exportId = (exportResult as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;

  qrrPersonalised = mintQrr("1");
  qrrDoorDrop = mintQrr("2");
  qrrInvalid = "210000000003139471430009099"; // last digit wrong → mod-10 fail

  await db.insert(swissQrReferences).values([
    {
      orgId: ORG_ID,
      campaignId,
      constituentId: constituentPersonalisedId,
      exportId,
      bankAccountId,
      referenceType: "qrr",
      reference: qrrPersonalised,
      currency: "CHF",
    },
    {
      orgId: ORG_ID,
      campaignId,
      constituentId: null, // door-drop
      exportId,
      bankAccountId,
      referenceType: "qrr",
      reference: qrrDoorDrop,
      currency: "CHF",
    },
  ]);
});

beforeEach(() => {
  fakeStorage.clear();
  moveRejectedMock.mockClear();
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM camt_unreconciled_entries WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM camt_credit_entries WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM camt_statements WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM swiss_qr_references WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaign_postal_exports WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id = ${ORG_ID}`);
});

async function uploadFixture(args: {
  fixture: string;
  qrrA?: string;
  qrrB?: string;
  qrrDoorDrop?: string;
  msgIdSuffix?: string;
  /**
   * Suffix appended to every AcctSvcrRef / EndToEndId in the fixture
   * so re-uploads with different msgIds don't collide on the
   * `(org_id, payment_method, payment_ref)` UNIQUE on donations. Tests
   * that re-use the same fixture template across describe blocks
   * MUST pass a distinct suffix.
   */
  acctSvcrRefSuffix?: string;
}): Promise<{ statementId: string; s3Key: string }> {
  let xml = loadFixture(args.fixture);
  if (args.qrrA) xml = xml.replace("__QRR_PLACEHOLDER_A__", args.qrrA);
  if (args.qrrB) xml = xml.replace("__QRR_PLACEHOLDER_B__", args.qrrB);
  if (args.qrrDoorDrop) xml = xml.replace("__QRR_PLACEHOLDER_DOORDROP__", args.qrrDoorDrop);
  if (args.msgIdSuffix) {
    xml = xml.replace(/<MsgId>[^<]+<\/MsgId>/, `<MsgId>MSG-${args.msgIdSuffix}</MsgId>`);
  }
  if (args.acctSvcrRefSuffix) {
    const sfx = args.acctSvcrRefSuffix;
    xml = xml.replace(/<AcctSvcrRef>([^<]+)<\/AcctSvcrRef>/g, `<AcctSvcrRef>$1-${sfx}</AcctSvcrRef>`);
    xml = xml.replace(/<EndToEndId>([^<]+)<\/EndToEndId>/g, `<EndToEndId>$1-${sfx}</EndToEndId>`);
  }
  const s3Key = `${ORG_ID}/camt053/2026/05/${Math.random().toString(36).slice(2, 10)}_${args.fixture}`;
  fakeStorage.set(s3Key, Buffer.from(xml, "utf-8"));
  const [row] = await db
    .insert(camtStatements)
    .values({
      orgId: ORG_ID,
      bankAccountId,
      s3Path: s3Key,
      msgId: `__pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      status: "pending",
    })
    .returning();
  return { statementId: row!.id, s3Key };
}

describe("camt053-import — happy path + idempotency", () => {
  it("parses and persists two credit entries", async () => {
    const { statementId } = await uploadFixture({
      fixture: "happy-path.xml",
      qrrA: qrrPersonalised,
      qrrB: qrrDoorDrop,
      msgIdSuffix: "HAPPY-1",
    });
    await processCamt053Import(makeMockJob({ statementId, bankAccountId, orgId: ORG_ID }));
    const stmt = await db
      .select()
      .from(camtStatements)
      .where(and(eq(camtStatements.id, statementId), eq(camtStatements.orgId, ORG_ID)));
    expect(stmt[0]!.status).toBe("processing");
    expect(stmt[0]!.msgId).toBe("MSG-HAPPY-1");
    expect(stmt[0]!.totalCredits).toBe(2);

    const entries = await db
      .select()
      .from(camtCreditEntries)
      .where(eq(camtCreditEntries.statementId, statementId));
    expect(entries).toHaveLength(2);
    const refs = entries.map((e) => e.structuredRef).sort();
    expect(refs).toEqual([qrrPersonalised, qrrDoorDrop].sort());
  });

  it("is idempotent — second import is a no-op", async () => {
    const { statementId } = await uploadFixture({
      fixture: "happy-path.xml",
      qrrA: qrrPersonalised,
      qrrB: qrrDoorDrop,
      msgIdSuffix: "HAPPY-RETRY",
    });
    await processCamt053Import(makeMockJob({ statementId, bankAccountId, orgId: ORG_ID }));
    // Second run should short-circuit on status != 'pending'.
    await processCamt053Import(makeMockJob({ statementId, bankAccountId, orgId: ORG_ID }));
    const entries = await db
      .select()
      .from(camtCreditEntries)
      .where(eq(camtCreditEntries.statementId, statementId));
    expect(entries).toHaveLength(2);
  });

  it("rejects a foreign IBAN — file moved to rejected prefix, status=failed", async () => {
    const { statementId } = await uploadFixture({
      fixture: "foreign-iban.xml",
    });
    await processCamt053Import(makeMockJob({ statementId, bankAccountId, orgId: ORG_ID }));
    const [stmt] = await db
      .select()
      .from(camtStatements)
      .where(and(eq(camtStatements.id, statementId), eq(camtStatements.orgId, ORG_ID)));
    expect(stmt!.status).toBe("failed");
    expect(stmt!.error).toMatch(/^foreign_iban:/);
    expect(moveRejectedMock).toHaveBeenCalledTimes(1);
  });

  it("detects duplicate MsgId — second statement marked failed", async () => {
    const first = await uploadFixture({
      fixture: "happy-path.xml",
      qrrA: qrrPersonalised,
      qrrB: qrrDoorDrop,
      msgIdSuffix: "DUP-MSG",
    });
    await processCamt053Import(
      makeMockJob({ statementId: first.statementId, bankAccountId, orgId: ORG_ID }),
    );
    const second = await uploadFixture({
      fixture: "happy-path.xml",
      qrrA: qrrPersonalised,
      qrrB: qrrDoorDrop,
      msgIdSuffix: "DUP-MSG", // same MsgId
    });
    await processCamt053Import(
      makeMockJob({ statementId: second.statementId, bankAccountId, orgId: ORG_ID }),
    );
    const [stmt] = await db
      .select()
      .from(camtStatements)
      .where(and(eq(camtStatements.id, second.statementId), eq(camtStatements.orgId, ORG_ID)));
    expect(stmt!.status).toBe("failed");
    expect(stmt!.error).toMatch(/^duplicate_msg_id:/);
  });
});

describe("camt053-reconcile — personalized rail", () => {
  it("matches via swiss_qr_references.constituent_id and creates a donation", async () => {
    const { statementId } = await uploadFixture({
      fixture: "happy-path.xml",
      qrrA: qrrPersonalised,
      qrrB: qrrInvalid, // second entry will go to unreconciled (invalid_ref)
      msgIdSuffix: "RECONCILE-1",
    });
    await processCamt053Import(makeMockJob({ statementId, bankAccountId, orgId: ORG_ID }));
    await processCamt053Reconcile(makeMockJob({ statementId }));

    const [stmt] = await db.select().from(camtStatements).where(eq(camtStatements.id, statementId));
    expect(stmt!.status).toBe("processed");
    expect(stmt!.matchedCredits).toBe(1);
    expect(stmt!.unmatchedCredits).toBe(1);

    const donationRows = await db
      .select()
      .from(donations)
      .where(
        and(
          eq(donations.orgId, ORG_ID),
          eq(donations.constituentId, constituentPersonalisedId),
          eq(donations.paymentSource, "camt053"),
        ),
      );
    expect(donationRows.length).toBeGreaterThanOrEqual(1);
    expect(donationRows[0]!.amountCents).toBe(5000);

    const unrec = await db
      .select()
      .from(camtUnreconciledEntries)
      .where(eq(camtUnreconciledEntries.orgId, ORG_ID));
    expect(unrec.some((u) => u.reason === "invalid_ref")).toBe(true);
  });
});

describe("camt053-reconcile — door-drop find-or-create + enrichment", () => {
  it("auto-creates a constituent from the §5.5 extraction matrix", async () => {
    const { statementId } = await uploadFixture({
      fixture: "name-only-debtor.xml",
      qrrDoorDrop,
      msgIdSuffix: "DOORDROP-1",
    });
    await processCamt053Import(makeMockJob({ statementId, bankAccountId, orgId: ORG_ID }));
    await processCamt053Reconcile(makeMockJob({ statementId }));

    const created = await db
      .select()
      .from(constituents)
      .where(
        and(
          eq(constituents.orgId, ORG_ID),
          eq(constituents.dataSource, "camt053"),
          eq(constituents.lastName, "Garcia"),
        ),
      );
    expect(created.length).toBe(1);
    expect(created[0]!.firstName).toBe("Maria");
    expect(created[0]!.paymentSourceIban).toBe("CH5104835012345678123");
    // No address on this fixture → partial (name + IBAN, no email no addr).
    expect(created[0]!.identityCompleteness).toBe("partial");
  });
});

describe("camt053-reconcile — reversal handling (docs/25 §5.2)", () => {
  it("INSERTs a reversal donation row, leaves the original untouched", async () => {
    // ── 1. Book the original donation via the personalised rail. ──
    const originalQrr = mintQrr("7001");
    const exportR1 = await db.execute(
      sql`INSERT INTO campaign_postal_exports (org_id, campaign_id, mode, status, total_count, progress_count)
          VALUES (${ORG_ID}, ${campaignId}, 'personalized', 'completed', 1, 1) RETURNING id`,
    );
    const exportR1Id = (exportR1 as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
    const [revConstituent] = await db
      .insert(constituents)
      .values({
        orgId: ORG_ID,
        firstName: "Hans",
        lastName: "Reverser",
        type: "donor",
      })
      .returning();
    await db.insert(swissQrReferences).values([
      {
        orgId: ORG_ID,
        campaignId,
        constituentId: revConstituent!.id,
        exportId: exportR1Id,
        bankAccountId,
        referenceType: "qrr",
        reference: originalQrr,
        currency: "CHF",
      },
    ]);

    const original = await uploadFixture({
      fixture: "happy-path.xml",
      qrrA: originalQrr,
      qrrB: mintQrr("7099"), // no swiss_qr_references row → goes to unreconciled
      msgIdSuffix: "REV-ORIGINAL",
      acctSvcrRefSuffix: "REV", // avoid colliding with other tests' BKID-001-A
    });
    await processCamt053Import(
      makeMockJob({ statementId: original.statementId, bankAccountId, orgId: ORG_ID }),
    );
    await processCamt053Reconcile(makeMockJob({ statementId: original.statementId }));

    const [originalDonation] = await db
      .select()
      .from(donations)
      .where(
        and(
          eq(donations.orgId, ORG_ID),
          eq(donations.constituentId, revConstituent!.id),
          eq(donations.paymentSource, "camt053"),
        ),
      );
    expect(originalDonation).toBeDefined();
    expect(originalDonation!.status).toBe("cleared");
    expect(originalDonation!.amountCents).toBe(5000);
    expect(originalDonation!.reversesDonationId).toBeNull();

    // ── 2. Apply the reversal. ─────────────────────────────────────
    const reversal = await uploadFixture({
      fixture: "reversal.xml",
      qrrA: originalQrr,
      msgIdSuffix: "REV-APPLY",
    });
    await processCamt053Import(
      makeMockJob({ statementId: reversal.statementId, bankAccountId, orgId: ORG_ID }),
    );
    await processCamt053Reconcile(makeMockJob({ statementId: reversal.statementId }));

    // ── 3. Original donation row is UNCHANGED. ─────────────────────
    const [originalAfter] = await db
      .select()
      .from(donations)
      .where(eq(donations.id, originalDonation!.id));
    expect(originalAfter!.status).toBe("cleared");
    expect(originalAfter!.amountCents).toBe(5000);
    expect(originalAfter!.reversesDonationId).toBeNull();

    // ── 4. A NEW reversal donation row exists with the expected shape. ──
    const reversalRows = await db
      .select()
      .from(donations)
      .where(
        and(
          eq(donations.orgId, ORG_ID),
          eq(donations.reversesDonationId, originalDonation!.id),
        ),
      );
    expect(reversalRows).toHaveLength(1);
    const reversalDonation = reversalRows[0]!;
    expect(reversalDonation.amountCents).toBe(-5000);
    expect(reversalDonation.status).toBe("refunded");
    expect(reversalDonation.paymentSource).toBe("camt053");
    expect(reversalDonation.paymentMethod).toBe("camt053");
    expect(reversalDonation.paymentRef).toBe("BKID-REV-001");
    expect(reversalDonation.swissQrReferenceId).toBe(originalDonation!.swissQrReferenceId);
    expect(reversalDonation.campaignId).toBe(originalDonation!.campaignId);
    expect(reversalDonation.constituentId).toBe(originalDonation!.constituentId);

    // ── 5. The reversal credit entry points at the NEW reversal row. ──
    const [reversalEntry] = await db
      .select()
      .from(camtCreditEntries)
      .where(
        and(eq(camtCreditEntries.orgId, ORG_ID), eq(camtCreditEntries.acctSvcrRef, "BKID-REV-001")),
      );
    expect(reversalEntry).toBeDefined();
    expect(reversalEntry!.donationId).toBe(reversalDonation.id);

    // ── 6. donation.refunded outbox event carries the NEW donation id. ──
    const outboxRows = await db.execute(sql<{ payload: unknown }>`
      SELECT payload FROM outbox_events
      WHERE tenant_id = ${ORG_ID}
        AND type = 'donation.refunded'
        AND payload->>'donationId' = ${reversalDonation.id}
    `);
    const eventRows = (outboxRows as unknown as { rows: Array<{ payload: { donationId: string; reversesDonationId: string } }> }).rows;
    expect(eventRows.length).toBeGreaterThanOrEqual(1);
    expect(eventRows[0]!.payload.reversesDonationId).toBe(originalDonation!.id);
  });

  it("queues orphan_reversal when no original donation matches", async () => {
    const orphanQrr = mintQrr("7500");
    const orphanExport = await db.execute(
      sql`INSERT INTO campaign_postal_exports (org_id, campaign_id, mode, status, total_count, progress_count)
          VALUES (${ORG_ID}, ${campaignId}, 'personalized', 'completed', 1, 1) RETURNING id`,
    );
    const orphanExportId = (orphanExport as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
    const [orphanConstituent] = await db
      .insert(constituents)
      .values({
        orgId: ORG_ID,
        firstName: "Orphan",
        lastName: "Reverser",
        type: "donor",
      })
      .returning();
    await db.insert(swissQrReferences).values([
      {
        orgId: ORG_ID,
        campaignId,
        constituentId: orphanConstituent!.id,
        exportId: orphanExportId,
        bankAccountId,
        referenceType: "qrr",
        reference: orphanQrr,
        currency: "CHF",
      },
    ]);

    // Upload only the reversal — no prior donation exists for this ref.
    const reversal = await uploadFixture({
      fixture: "reversal.xml",
      qrrA: orphanQrr,
      msgIdSuffix: "REV-ORPHAN",
    });
    await processCamt053Import(
      makeMockJob({ statementId: reversal.statementId, bankAccountId, orgId: ORG_ID }),
    );
    await processCamt053Reconcile(makeMockJob({ statementId: reversal.statementId }));

    const unrec = await db
      .select()
      .from(camtUnreconciledEntries)
      .innerJoin(camtCreditEntries, eq(camtUnreconciledEntries.creditEntryId, camtCreditEntries.id))
      .where(
        and(
          eq(camtUnreconciledEntries.orgId, ORG_ID),
          eq(camtUnreconciledEntries.reason, "orphan_reversal"),
          eq(camtCreditEntries.acctSvcrRef, "BKID-REV-001"),
        ),
      );
    expect(unrec.length).toBe(1);
  });
});

describe("camt053-reconcile — partial-match handling (docs/25 §5.4 step 4.d)", () => {
  it("books the donation at the credited amount AND writes a pre-resolved audit row", async () => {
    // The personalised ref carries a PRINTED expected amount of CHF 100
    // (10000 cents). The partial-match fixture pays CHF 80 (8000 cents).
    const pmQrr = mintQrr("8001");
    const pmExport = await db.execute(
      sql`INSERT INTO campaign_postal_exports (org_id, campaign_id, mode, status, total_count, progress_count)
          VALUES (${ORG_ID}, ${campaignId}, 'personalized', 'completed', 1, 1) RETURNING id`,
    );
    const pmExportId = (pmExport as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
    const [pmConstituent] = await db
      .insert(constituents)
      .values({
        orgId: ORG_ID,
        firstName: "Anna",
        lastName: "Frei",
        type: "donor",
      })
      .returning();
    await db.insert(swissQrReferences).values([
      {
        orgId: ORG_ID,
        campaignId,
        constituentId: pmConstituent!.id,
        exportId: pmExportId,
        bankAccountId,
        referenceType: "qrr",
        reference: pmQrr,
        amountCents: 10000, // printed CHF 100
        currency: "CHF",
      },
    ]);

    // Load the fixture and inject our partial-match QRR.
    let xml = loadFixture("partial-match.xml");
    xml = xml.replace("__QRR_PLACEHOLDER_PM__", pmQrr);
    const s3Key = `${ORG_ID}/camt053/2026/05/partial-match.xml`;
    fakeStorage.set(s3Key, Buffer.from(xml, "utf-8"));
    const [stmtRow] = await db
      .insert(camtStatements)
      .values({
        orgId: ORG_ID,
        bankAccountId,
        s3Path: s3Key,
        msgId: `__pending_pm_${Date.now()}`,
        status: "pending",
      })
      .returning();

    await processCamt053Import(makeMockJob({ statementId: stmtRow!.id, bankAccountId, orgId: ORG_ID }));
    await processCamt053Reconcile(makeMockJob({ statementId: stmtRow!.id }));

    // ── 1. Donation booked at the CREDITED amount (CHF 80). ────────
    const donationRows = await db
      .select()
      .from(donations)
      .where(
        and(eq(donations.orgId, ORG_ID), eq(donations.constituentId, pmConstituent!.id)),
      );
    expect(donationRows).toHaveLength(1);
    expect(donationRows[0]!.amountCents).toBe(8000);
    expect(donationRows[0]!.status).toBe("cleared");
    expect(donationRows[0]!.paymentMethod).toBe("camt053");

    // ── 2. Credit entry has partial_match=true. ─────────────────────
    const [pmEntry] = await db
      .select()
      .from(camtCreditEntries)
      .where(
        and(eq(camtCreditEntries.orgId, ORG_ID), eq(camtCreditEntries.acctSvcrRef, "BKID-PM-001")),
      );
    expect(pmEntry).toBeDefined();
    expect(pmEntry!.partialMatch).toBe(true);
    expect(pmEntry!.donationId).toBe(donationRows[0]!.id);

    // ── 3. A pre-resolved audit row exists (reason=partial_match, status=resolved). ──
    const auditRows = await db
      .select()
      .from(camtUnreconciledEntries)
      .where(
        and(
          eq(camtUnreconciledEntries.orgId, ORG_ID),
          eq(camtUnreconciledEntries.creditEntryId, pmEntry!.id),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.reason).toBe("partial_match");
    expect(auditRows[0]!.status).toBe("resolved");
    expect(auditRows[0]!.resolvedAt).not.toBeNull();

    // ── 4. The active-queue filter (status='pending') EXCLUDES it. ──
    const activeQueue = await db
      .select()
      .from(camtUnreconciledEntries)
      .where(
        and(
          eq(camtUnreconciledEntries.orgId, ORG_ID),
          eq(camtUnreconciledEntries.creditEntryId, pmEntry!.id),
          eq(camtUnreconciledEntries.status, "pending"),
        ),
      );
    expect(activeQueue).toHaveLength(0);
  });

  it("does NOT flag partial_match when the printed amount is 0 (donor-fills)", async () => {
    // qrrDoorDrop has amountCents=0 (set in beforeAll via the default).
    // The door-drop fixture pays an arbitrary amount; no partial_match.
    const { statementId } = await uploadFixture({
      fixture: "name-only-debtor.xml",
      qrrDoorDrop,
      msgIdSuffix: "PM-DONOR-FILLS",
    });
    await processCamt053Import(makeMockJob({ statementId, bankAccountId, orgId: ORG_ID }));
    await processCamt053Reconcile(makeMockJob({ statementId }));

    // No partial_match row anywhere.
    const partialRows = await db
      .select()
      .from(camtUnreconciledEntries)
      .innerJoin(camtCreditEntries, eq(camtUnreconciledEntries.creditEntryId, camtCreditEntries.id))
      .where(
        and(
          eq(camtUnreconciledEntries.orgId, ORG_ID),
          eq(camtUnreconciledEntries.reason, "partial_match"),
          eq(camtCreditEntries.statementId, statementId),
        ),
      );
    expect(partialRows).toHaveLength(0);
  });
});

describe("identity_completeness derivation", () => {
  it("structured PstlAdr → full", async () => {
    // Use a different IBAN to avoid hitting the enrichment branch of an
    // existing constituent from prior tests.
    const xml = loadFixture("happy-path.xml")
      .replace("__QRR_PLACEHOLDER_A__", mintQrr("9001"))
      .replace("__QRR_PLACEHOLDER_B__", mintQrr("9002"))
      .replace(/<MsgId>[^<]+<\/MsgId>/, "<MsgId>MSG-FULL-1</MsgId>")
      .replace("CH9300762011623852900", "CH4900762011999999900")
      .replace("CH5604835012345678009", "CH4900762011999999901");
    const s3Key = `${ORG_ID}/camt053/2026/05/full-test.xml`;
    fakeStorage.set(s3Key, Buffer.from(xml, "utf-8"));
    const [row] = await db
      .insert(camtStatements)
      .values({
        orgId: ORG_ID,
        bankAccountId,
        s3Path: s3Key,
        msgId: `__pending_full_${Date.now()}`,
        status: "pending",
      })
      .returning();

    // Each ref needs its OWN export row — the partial unique on
    // `(export_id, COALESCE(constituent_id, sentinel))` lets a single
    // export carry at most one door-drop ref. We create two fresh
    // exports for the two QRRs in this test.
    const exp1 = await db.execute(
      sql`INSERT INTO campaign_postal_exports (org_id, campaign_id, mode, status, total_count, progress_count)
          VALUES (${ORG_ID}, ${campaignId}, 'door_drop', 'completed', 1, 1) RETURNING id`,
    );
    const exp2 = await db.execute(
      sql`INSERT INTO campaign_postal_exports (org_id, campaign_id, mode, status, total_count, progress_count)
          VALUES (${ORG_ID}, ${campaignId}, 'door_drop', 'completed', 1, 1) RETURNING id`,
    );
    const exportId1 = (exp1 as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
    const exportId2 = (exp2 as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;
    const qrrA = mintQrr("9001");
    const qrrB = mintQrr("9002");
    await db.insert(swissQrReferences).values([
      {
        orgId: ORG_ID,
        campaignId,
        constituentId: null,
        exportId: exportId1,
        bankAccountId,
        referenceType: "qrr",
        reference: qrrA,
        currency: "CHF",
      },
      {
        orgId: ORG_ID,
        campaignId,
        constituentId: null,
        exportId: exportId2,
        bankAccountId,
        referenceType: "qrr",
        reference: qrrB,
        currency: "CHF",
      },
    ]);

    await processCamt053Import(makeMockJob({ statementId: row!.id, bankAccountId, orgId: ORG_ID }));
    await processCamt053Reconcile(makeMockJob({ statementId: row!.id }));

    // Jean Dupont got a full address.
    const dupont = await db
      .select()
      .from(constituents)
      .where(
        and(
          eq(constituents.orgId, ORG_ID),
          eq(constituents.paymentSourceIban, "CH4900762011999999900"),
        ),
      );
    expect(dupont).toHaveLength(1);
    expect(dupont[0]!.identityCompleteness).toBe("full");
    expect(dupont[0]!.city).toBe("Lausanne");
    expect(dupont[0]!.postalCode).toBe("1003");
  });
});
