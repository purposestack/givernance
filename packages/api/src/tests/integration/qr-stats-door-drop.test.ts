/**
 * QR-stats door-drop sticky `paidQrBills` test (Epic #318 PR #5 harden H3).
 *
 * The docs hardening (`docs/25` §5.3 financial-integrity rule) requires
 * the door-drop branch of `paidQrBills` to count DISTINCT debtor IBANs
 * from camt.053 credit entries, NOT distinct constituents. A donor's
 * GDPR Art. 17 erasure must not silently decrement the historical paid
 * count — the count tracks the camt.053 financial reality, not the
 * constituent graph.
 *
 * Setup: a door-drop campaign with two camt.053-matched donations from
 * two distinct debtor IBANs.
 *
 *   Initial state  →  paidQrBills = 2
 *   Erase one constituent (set deleted_at) → paidQrBills STILL = 2
 *
 * Compare to the BUGGY prior behaviour (`count(DISTINCT constituent_id)`):
 * the erasure would decrement to 1, because the FK from
 * `swiss_qr_references.constituent_id` and from `donations.constituent_id`
 * sets the constituent pointer to NULL, and DISTINCT on a NULL collapses
 * to a different value than the live constituent. The new shape counts
 * the IBAN on the credit entry — invariant under constituent mutations.
 */

import {
  bankAccounts,
  campaigns,
  camtCreditEntries,
  camtStatements,
  constituents,
  donations,
  swissQrReferences,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../lib/db.js";
import { getCampaignQrStats } from "../../modules/campaigns/qr-stats-service.js";

const ORG_ID = "00000000-0000-0000-0000-0000000d055f";
const BANK_ACCT_IBAN = "CH9300762011623852957";

let bankAccountId: string;
let campaignId: string;
let constituentIbanAId: string;
let constituentIbanBId: string;
let exportId: string;
let doorDropRefId: string;
let statementId: string;

beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_ID}, 'QR Stats Sticky Org', 'qr-stats-sticky') ON CONFLICT (id) DO NOTHING`,
  );
  // Tear-down — re-runnable in dev.
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
      holderName: "Sticky Org",
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
      name: "Sticky Door-Drop",
      type: "door_drop",
      status: "active",
      bankAccountId,
    })
    .returning();
  campaignId = campaign!.id;

  const exportRes = await db.execute(
    sql`INSERT INTO campaign_postal_exports (org_id, campaign_id, mode, status, total_count, progress_count)
        VALUES (${ORG_ID}, ${campaignId}, 'door_drop', 'completed', 1, 1) RETURNING id`,
  );
  exportId = (exportRes as unknown as { rows: Array<{ id: string }> }).rows[0]!.id;

  // ONE door-drop ref (constituent_id NULL) — the shape minted at
  // postal-export time for door-drop campaigns.
  const [ref] = await db
    .insert(swissQrReferences)
    .values({
      orgId: ORG_ID,
      campaignId,
      constituentId: null,
      exportId,
      bankAccountId,
      referenceType: "qrr",
      reference: "210000000003139471430009017",
      currency: "CHF",
    })
    .returning();
  doorDropRefId = ref!.id;

  // Two constituents that the reconciler "auto-created from camt.053".
  const [cA] = await db
    .insert(constituents)
    .values({
      orgId: ORG_ID,
      firstName: "Alice",
      lastName: "Sticky-A",
      type: "donor",
      dataSource: "camt053",
      paymentSourceIban: "CH4900762011999999800",
    })
    .returning();
  constituentIbanAId = cA!.id;
  const [cB] = await db
    .insert(constituents)
    .values({
      orgId: ORG_ID,
      firstName: "Bob",
      lastName: "Sticky-B",
      type: "donor",
      dataSource: "camt053",
      paymentSourceIban: "CH4900762011999999801",
    })
    .returning();
  constituentIbanBId = cB!.id;

  // One processed statement to support the camt_credit_entries FK.
  const [stmt] = await db
    .insert(camtStatements)
    .values({
      orgId: ORG_ID,
      bankAccountId,
      s3Path: `${ORG_ID}/camt053/2026/05/sticky-test.xml`,
      msgId: "STICKY-MSG-001",
      status: "processed",
      totalCredits: 2,
      matchedCredits: 2,
      unmatchedCredits: 0,
    })
    .returning();
  statementId = stmt!.id;

  // Two donations + their backing camt_credit_entries — one per IBAN.
  for (const [idx, [constId, iban, ref]] of [
    [constituentIbanAId, "CH4900762011999999800", "BKID-STICKY-A"],
    [constituentIbanBId, "CH4900762011999999801", "BKID-STICKY-B"],
  ].entries()) {
    const [d] = await db
      .insert(donations)
      .values({
        orgId: ORG_ID,
        constituentId: constId as string,
        amountCents: 5000,
        amountBaseCents: 5000,
        currency: "CHF",
        campaignId,
        swissQrReferenceId: doorDropRefId,
        paymentSource: "camt053",
        status: "cleared",
        paymentMethod: "camt053",
        paymentRef: ref as string,
      })
      .returning();
    const [ce] = await db
      .insert(camtCreditEntries)
      .values({
        orgId: ORG_ID,
        statementId,
        acctSvcrRef: ref as string,
        endToEndId: `EE-${idx}`,
        amountCents: 5000,
        currency: "CHF",
        structuredRef: "210000000003139471430009017",
        debtorName: idx === 0 ? "Alice Sticky-A" : "Bob Sticky-B",
        debtorIban: iban as string,
        reversalIndicator: false,
        donationId: d!.id,
      })
      .returning();
    void ce;
  }
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM camt_credit_entries WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM camt_statements WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM donations WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM swiss_qr_references WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaign_postal_exports WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM constituents WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM campaigns WHERE org_id = ${ORG_ID}`);
  await db.execute(sql`DELETE FROM bank_accounts WHERE org_id = ${ORG_ID}`);
});

describe("door-drop paidQrBills — sticky by IBAN (GDPR Art. 17 financial-integrity)", () => {
  it("counts 2 distinct IBANs from camt entries (initial state)", async () => {
    const stats = await getCampaignQrStats(ORG_ID, campaignId);
    expect(stats).not.toBeNull();
    expect(stats!.swissRail).not.toBeNull();
    expect(stats!.swissRail!.paidQrBills).toBe(2);
    expect(stats!.swissRail!.pendingQrBills).toBeNull(); // door-drop never has pending
  });

  it("erasing one constituent does NOT decrement paidQrBills", async () => {
    // Simulate GDPR Art. 17 erasure: set deleted_at on the constituent.
    // (In production the constituent row's PII fields are scrubbed; we
    // only need to flip deleted_at for this invariant test.)
    await db
      .update(constituents)
      .set({ deletedAt: new Date() })
      .where(and(eq(constituents.id, constituentIbanAId), eq(constituents.orgId, ORG_ID)));

    const stats = await getCampaignQrStats(ORG_ID, campaignId);
    expect(stats!.swissRail!.paidQrBills).toBe(2);
  });

  it("a matched camt entry with NULL debtor_iban (TWINT-anonymised) is excluded from the count", async () => {
    // Add a third matched donation backed by a camt entry with NULL
    // debtor_iban (the TWINT-anonymised path that somehow still
    // reference-matched). It IS a real matched donation but the
    // sticky-distinct count can't honour the IBAN-distinct semantic
    // for it — it stays out. (The operator surfaces such entries via
    // the no_debtor_info queue in the normal flow.)
    const [twintC] = await db
      .insert(constituents)
      .values({
        orgId: ORG_ID,
        firstName: "TWINT",
        lastName: "Anon",
        type: "donor",
        dataSource: "camt053",
      })
      .returning();
    const [twintD] = await db
      .insert(donations)
      .values({
        orgId: ORG_ID,
        constituentId: twintC!.id,
        amountCents: 2000,
        amountBaseCents: 2000,
        currency: "CHF",
        campaignId,
        swissQrReferenceId: doorDropRefId,
        paymentSource: "camt053",
        status: "cleared",
        paymentMethod: "camt053",
        paymentRef: "BKID-STICKY-TWINT",
      })
      .returning();
    await db.insert(camtCreditEntries).values({
      orgId: ORG_ID,
      statementId,
      acctSvcrRef: "BKID-STICKY-TWINT",
      amountCents: 2000,
      currency: "CHF",
      structuredRef: "210000000003139471430009017",
      debtorName: "TWINT",
      debtorIban: null,
      reversalIndicator: false,
      donationId: twintD!.id,
    });

    const stats = await getCampaignQrStats(ORG_ID, campaignId);
    expect(stats!.swissRail!.paidQrBills).toBe(2); // still 2 distinct non-NULL IBANs
  });
});
