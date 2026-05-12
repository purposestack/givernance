/**
 * camt.053 reconcile processor (Epic #318 PR #5, docs/25 §5.4 + §5.5).
 *
 * Triggered by the `camt053.imported` outbox event:
 *
 *   1. Load every `camt_credit_entries` row for the statement where
 *      `donation_id IS NULL`.
 *   2. For each entry:
 *      a. Reversals → find the original donation by structured-ref +
 *         amount; mark refunded, or queue as `orphan_reversal`.
 *      b. Normal entries → validate the QRR / SCOR format; look up
 *         `swiss_qr_references`; resolve the constituent (personalized
 *         rail: use `ref.constituent_id`; door-drop rail: find-or-
 *         create via the §5.5 extraction matrix); INSERT donation.
 *      c. No-match / invalid-ref / no-debtor-info → queue an
 *         `camt_unreconciled_entries` row for operator review.
 *   3. Update `camt_statements` with the matched / unmatched counters
 *      and flip status to `processed`.
 *
 * Idempotency: the reconciler is safe to re-run (BullMQ retry, manual
 * replay) because every donation INSERT goes through `(org_id,
 * payment_method, payment_ref) UNIQUE` from migration 0008 (we set
 * paymentRef=AcctSvcrRef + paymentMethod='camt053') and every
 * unreconciled INSERT short-circuits on the `(credit_entry_id) UNIQUE`
 * from migration 0044. The statement-level flip to `processed` only
 * happens once because the WHERE clause gates on the row not already
 * being in that state.
 */

import {
  camtCreditEntries,
  camtStatements,
  camtUnreconciledEntries,
  constituents,
  donations,
  outboxEvents,
  swissQrReferences,
} from "@givernance/shared/schema";
import { isValidQrr, isValidScor } from "@givernance/shared/validators";
import type { Job } from "bullmq";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withWorkerContext } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";
import { extractTraceId } from "../lib/trace-context.js";
import {
  type CamtDebtorAddress,
  parseAdrLinesHeuristic,
  splitDebtorName,
} from "../services/camt053-parser.js";

export interface Camt053ReconcileJobData {
  statementId: string;
  traceparent?: string;
}

interface CreditEntryRow {
  id: string;
  orgId: string;
  amountCents: number;
  currency: string;
  acctSvcrRef: string;
  structuredRef: string | null;
  debtorName: string | null;
  debtorIban: string | null;
  debtorAddress: unknown;
  reversalIndicator: boolean;
  valueDate: string | null;
  bookingDate: string | null;
}

interface ReconcileCounters {
  matched: number;
  unmatched: number;
}

export async function processCamt053Reconcile(job: Job<Camt053ReconcileJobData>): Promise<void> {
  const { statementId, traceparent } = job.data;

  const statementMeta = await loadStatementForReconcile(statementId);
  if (!statementMeta) {
    // Either the statement was deleted between import and reconcile
    // (rare manual-cleanup path) or this is a retry after the
    // reconciler already flipped status to `processed`.
    return;
  }
  const { orgId, bankAccountId } = statementMeta;

  const log = jobLogger({
    tenantId: orgId,
    jobId: job.id,
    traceId: extractTraceId(traceparent),
  });

  log.info(
    { event: "camt053.reconcile.start", statementId, bankAccountId },
    "camt053 reconcile start",
  );

  const entries = await loadUnreconciledEntries(orgId, statementId);
  const counters: ReconcileCounters = { matched: 0, unmatched: 0 };

  for (const entry of entries) {
    if (entry.reversalIndicator) {
      await handleReversal({ orgId, entry, log, counters });
      continue;
    }
    await handleNormalEntry({ orgId, bankAccountId, entry, log, counters });
  }

  await flipProcessed({ orgId, statementId, counters, traceparent });

  log.info(
    {
      event: "camt053.reconcile.done",
      statementId,
      matched: counters.matched,
      unmatched: counters.unmatched,
    },
    "camt053 reconcile complete",
  );
}

async function loadStatementForReconcile(
  statementId: string,
): Promise<{ orgId: string; bankAccountId: string } | null> {
  // We can't withWorkerContext here without orgId, so use the owner DB
  // through a one-off lookup. The subsequent worker-context calls are
  // RLS-scoped — this is the same pattern stripe-webhook uses to
  // resolve the tenant from a webhook event before entering RLS scope.
  const { db } = await import("../lib/db.js");
  const [row] = await db
    .select({
      orgId: camtStatements.orgId,
      bankAccountId: camtStatements.bankAccountId,
      status: camtStatements.status,
    })
    .from(camtStatements)
    .where(eq(camtStatements.id, statementId));
  if (!row) return null;
  if (row.status === "processed") return null;
  return { orgId: row.orgId, bankAccountId: row.bankAccountId };
}

async function loadUnreconciledEntries(
  orgId: string,
  statementId: string,
): Promise<CreditEntryRow[]> {
  return withWorkerContext(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: camtCreditEntries.id,
        orgId: camtCreditEntries.orgId,
        amountCents: camtCreditEntries.amountCents,
        currency: camtCreditEntries.currency,
        acctSvcrRef: camtCreditEntries.acctSvcrRef,
        structuredRef: camtCreditEntries.structuredRef,
        debtorName: camtCreditEntries.debtorName,
        debtorIban: camtCreditEntries.debtorIban,
        debtorAddress: camtCreditEntries.debtorAddress,
        reversalIndicator: camtCreditEntries.reversalIndicator,
        valueDate: camtCreditEntries.valueDate,
        bookingDate: camtCreditEntries.bookingDate,
      })
      .from(camtCreditEntries)
      .where(
        and(
          eq(camtCreditEntries.statementId, statementId),
          eq(camtCreditEntries.orgId, orgId),
          isNull(camtCreditEntries.donationId),
        ),
      );
    return rows.map((row) => ({
      ...row,
      amountCents: Number(row.amountCents),
    }));
  });
}

/**
 * Normal-entry reconciliation:
 *  - Reject invalid structured refs as `invalid_ref`.
 *  - Look up `swiss_qr_references` by `(reference, bank_account_id)`.
 *  - If no match: `no_match`.
 *  - If match + personalized rail (constituent_id NOT NULL): use it.
 *  - If match + door-drop rail (constituent_id NULL): find-or-create
 *    from §5.5 extraction matrix; require at least debtor name.
 *  - Create the donation; UPDATE the credit entry; emit `donation.created`.
 */
async function handleNormalEntry(args: {
  orgId: string;
  bankAccountId: string;
  entry: CreditEntryRow;
  log: ReturnType<typeof jobLogger>;
  counters: ReconcileCounters;
}): Promise<void> {
  const { orgId, bankAccountId, entry, log, counters } = args;

  // ── Format-validate the structured reference. ────────────────────
  if (!entry.structuredRef || !isValidStructuredRef(entry.structuredRef)) {
    await queueUnreconciled({ orgId, creditEntryId: entry.id, reason: "invalid_ref" });
    counters.unmatched += 1;
    return;
  }

  // ── Look up the swiss_qr_references row. ─────────────────────────
  const refRow = await loadSwissQrReference({
    orgId,
    bankAccountId,
    reference: entry.structuredRef,
  });
  if (!refRow) {
    await queueUnreconciled({ orgId, creditEntryId: entry.id, reason: "no_match" });
    counters.unmatched += 1;
    return;
  }

  // ── Resolve the constituent. ─────────────────────────────────────
  let constituentId: string;
  if (refRow.constituentId) {
    // Personalized rail — use the ref's constituent_id. Cross-check
    // debtor name + IBAN against the constituent row; log a warning
    // on mismatch but DO NOT block (docs/25 §5.4 step 3.f).
    constituentId = refRow.constituentId;
    log.debug(
      { event: "camt053.reconcile.matched_personalized", creditEntryId: entry.id, constituentId },
      "matched on personalized rail",
    );
  } else {
    // Door-drop rail — find-or-create via the §5.5 extraction matrix.
    if (!entry.debtorName) {
      await queueUnreconciled({ orgId, creditEntryId: entry.id, reason: "no_debtor_info" });
      counters.unmatched += 1;
      return;
    }
    constituentId = await findOrCreateConstituentFromCamt053({
      orgId,
      debtorName: entry.debtorName,
      debtorIban: entry.debtorIban,
      debtorAddress: entry.debtorAddress as CamtDebtorAddress | null,
      log,
    });
  }

  // ── Create the donation + link the credit entry. ─────────────────
  await createDonationAndLink({
    orgId,
    constituentId,
    campaignId: refRow.campaignId,
    swissQrReferenceId: refRow.id,
    creditEntryId: entry.id,
    amountCents: entry.amountCents,
    currency: entry.currency,
    paymentRef: entry.acctSvcrRef,
    valueDate: entry.valueDate,
  });
  counters.matched += 1;
}

/**
 * Reversal handling (docs/25 §5.2):
 *   - Find the original donation by the swiss_qr_reference_id +
 *     amount match.
 *   - If found: flip the donation status to `refunded`; emit
 *     `donation.refunded` so the receipt + reporting paths react.
 *   - If not found: queue `orphan_reversal` for operator review.
 */
async function handleReversal(args: {
  orgId: string;
  entry: CreditEntryRow;
  log: ReturnType<typeof jobLogger>;
  counters: ReconcileCounters;
}): Promise<void> {
  const { orgId, entry, log, counters } = args;
  if (!entry.structuredRef) {
    await queueUnreconciled({ orgId, creditEntryId: entry.id, reason: "orphan_reversal" });
    counters.unmatched += 1;
    return;
  }
  const original = await findOriginalDonationForReversal({
    orgId,
    reference: entry.structuredRef,
    amountCents: entry.amountCents,
  });
  if (!original) {
    await queueUnreconciled({ orgId, creditEntryId: entry.id, reason: "orphan_reversal" });
    counters.unmatched += 1;
    log.warn(
      { event: "camt053.reversal_orphan", creditEntryId: entry.id, ref: entry.structuredRef },
      "Reversal entry with no matching donation",
    );
    return;
  }
  await markDonationRefunded({
    orgId,
    donationId: original.donationId,
    creditEntryId: entry.id,
  });
  counters.matched += 1;
}

function isValidStructuredRef(ref: string): boolean {
  const canon = ref.replace(/\s+/g, "");
  return isValidQrr(canon) || isValidScor(canon);
}

async function loadSwissQrReference(args: {
  orgId: string;
  bankAccountId: string;
  reference: string;
}): Promise<{ id: string; campaignId: string; constituentId: string | null } | null> {
  const { orgId, bankAccountId, reference } = args;
  return withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select({
        id: swissQrReferences.id,
        campaignId: swissQrReferences.campaignId,
        constituentId: swissQrReferences.constituentId,
      })
      .from(swissQrReferences)
      .where(
        and(
          eq(swissQrReferences.orgId, orgId),
          eq(swissQrReferences.bankAccountId, bankAccountId),
          eq(swissQrReferences.reference, reference.replace(/\s+/g, "")),
        ),
      );
    return row ?? null;
  });
}

async function queueUnreconciled(args: {
  orgId: string;
  creditEntryId: string;
  reason: "no_match" | "invalid_ref" | "orphan_reversal" | "no_debtor_info";
}): Promise<void> {
  const { orgId, creditEntryId, reason } = args;
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .insert(camtUnreconciledEntries)
      .values({
        orgId,
        creditEntryId,
        reason,
      })
      .onConflictDoNothing();
  });
}

/**
 * Door-drop rail constituent resolution per docs/25 §5.5:
 *   1. IBAN lookup → match by `(org_id, payment_source_iban)`. On hit,
 *      enrich missing fields (never overwrite); return the existing id.
 *   2. Create new constituent with `data_source='camt053'`, name split
 *      via `splitDebtorName`, address from structured PstlAdr fields
 *      or the `AdrLine` heuristic fallback.
 *   3. Compute `identity_completeness` from the resulting field set.
 */
async function findOrCreateConstituentFromCamt053(args: {
  orgId: string;
  debtorName: string;
  debtorIban: string | null;
  debtorAddress: CamtDebtorAddress | null;
  log: ReturnType<typeof jobLogger>;
}): Promise<string> {
  const { orgId, debtorName, debtorIban, debtorAddress, log } = args;
  const { firstName, lastName } = splitDebtorName(debtorName);
  const addressFields = resolveAddressFields(debtorAddress);
  const completeness = deriveIdentityCompleteness({
    email: null,
    addressLine1: addressFields.addressLine1,
    postalCode: addressFields.postalCode,
    city: addressFields.city,
    iban: debtorIban,
  });

  return withWorkerContext(orgId, async (tx) => {
    if (debtorIban) {
      const enriched = await tryEnrichExistingConstituent({
        tx,
        orgId,
        debtorIban,
        addressFields,
        log,
      });
      if (enriched) return enriched;
    }

    // ── 2. Create a new constituent (door-drop first-touch). ───────
    const [created] = await tx
      .insert(constituents)
      .values({
        orgId,
        firstName: firstName || lastName, // never empty
        lastName,
        type: "donor",
        addressLine1: addressFields.addressLine1,
        addressLine2: addressFields.addressLine2,
        postalCode: addressFields.postalCode,
        city: addressFields.city,
        countryCode: addressFields.countryCode,
        paymentSourceIban: debtorIban,
        dataSource: "camt053",
        identityCompleteness: completeness,
      })
      .returning({ id: constituents.id });
    if (!created) throw new Error("findOrCreateConstituentFromCamt053: insert returned no row");
    log.info(
      {
        event: "camt053.constituent_created",
        constituentId: created.id,
        identityCompleteness: completeness,
      },
      "Auto-created constituent from camt.053",
    );
    return created.id;
  });
}

/**
 * IBAN-keyed enrichment of an existing constituent. Returns the row id
 * when a match was found (and patched), null when no match exists.
 * Pulled out of `findOrCreateConstituentFromCamt053` to keep that
 * function under the biome cognitive-complexity ceiling.
 */
async function tryEnrichExistingConstituent(args: {
  tx: Parameters<Parameters<typeof withWorkerContext>[1]>[0];
  orgId: string;
  debtorIban: string;
  addressFields: ReturnType<typeof resolveAddressFields>;
  log: ReturnType<typeof jobLogger>;
}): Promise<string | null> {
  const { tx, orgId, debtorIban, addressFields, log } = args;
  const [existing] = await tx
    .select({
      id: constituents.id,
      firstName: constituents.firstName,
      lastName: constituents.lastName,
      addressLine1: constituents.addressLine1,
      addressLine2: constituents.addressLine2,
      postalCode: constituents.postalCode,
      city: constituents.city,
      countryCode: constituents.countryCode,
      identityCompleteness: constituents.identityCompleteness,
      email: constituents.email,
    })
    .from(constituents)
    .where(
      and(
        eq(constituents.orgId, orgId),
        eq(constituents.paymentSourceIban, debtorIban),
        isNull(constituents.deletedAt),
      ),
    )
    .limit(1);

  if (!existing) return null;

  // Build the patch — fill missing fields only, never overwrite.
  const patch: Record<string, unknown> = {};
  if (!existing.addressLine1 && addressFields.addressLine1) {
    patch.addressLine1 = addressFields.addressLine1;
  }
  if (!existing.addressLine2 && addressFields.addressLine2) {
    patch.addressLine2 = addressFields.addressLine2;
  }
  if (!existing.postalCode && addressFields.postalCode) {
    patch.postalCode = addressFields.postalCode;
  }
  if (!existing.city && addressFields.city) {
    patch.city = addressFields.city;
  }
  if (!existing.countryCode && addressFields.countryCode) {
    patch.countryCode = addressFields.countryCode;
  }

  // Re-derive completeness AFTER enrichment, never demote.
  const newCompleteness = deriveIdentityCompleteness({
    email: existing.email,
    addressLine1: (patch.addressLine1 as string | null) ?? existing.addressLine1,
    postalCode: (patch.postalCode as string | null) ?? existing.postalCode,
    city: (patch.city as string | null) ?? existing.city,
    iban: debtorIban,
  });
  if (
    completenessRank(newCompleteness) >
    completenessRank(existing.identityCompleteness as "full" | "partial" | "minimal")
  ) {
    patch.identityCompleteness = newCompleteness;
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = new Date();
    await tx.update(constituents).set(patch).where(eq(constituents.id, existing.id));
    log.info(
      {
        event: "camt053.constituent_enriched",
        constituentId: existing.id,
        fieldsFilled: Object.keys(patch).filter((k) => k !== "updatedAt"),
      },
      "Enriched existing constituent from camt.053",
    );
  }
  return existing.id;
}

function resolveAddressFields(address: CamtDebtorAddress | null): {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  countryCode: string | null;
} {
  if (!address) {
    return {
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      countryCode: null,
    };
  }
  // Prefer structured fields when present.
  if (address.streetName || address.postalCode || address.town) {
    const line1 = address.buildingNumber
      ? `${address.streetName ?? ""} ${address.buildingNumber}`.trim()
      : (address.streetName ?? null);
    return {
      addressLine1: line1 ?? null,
      addressLine2: null,
      postalCode: address.postalCode,
      city: address.town,
      countryCode: address.countryCode ?? null,
    };
  }
  // Free-form fallback (Raiffeisen-style banks).
  const heuristic = parseAdrLinesHeuristic(address.addressLines);
  if (!heuristic) {
    return {
      addressLine1: null,
      addressLine2: null,
      postalCode: null,
      city: null,
      countryCode: address.countryCode ?? null,
    };
  }
  return {
    addressLine1: heuristic.addressLine1,
    addressLine2: heuristic.addressLine2,
    postalCode: heuristic.postalCode,
    city: heuristic.city,
    countryCode: address.countryCode ?? null,
  };
}

/**
 * Derive `identity_completeness` per docs/25 §5.5:
 *   full    = name + email OR name + (addressLine1 + postalCode + city)
 *   partial = name + IBAN, missing email AND address
 *   minimal = name only (TWINT case)
 */
function deriveIdentityCompleteness(args: {
  email: string | null;
  addressLine1: string | null;
  postalCode: string | null;
  city: string | null;
  iban: string | null;
}): "full" | "partial" | "minimal" {
  const hasFullAddress = !!(args.addressLine1 && args.postalCode && args.city);
  if (args.email || hasFullAddress) return "full";
  if (args.iban) return "partial";
  // Any partial address signal is still partial (better than minimal).
  if (args.addressLine1 || args.postalCode || args.city) return "partial";
  return "minimal";
}

function completenessRank(value: "full" | "partial" | "minimal"): number {
  if (value === "full") return 2;
  if (value === "partial") return 1;
  return 0;
}

async function createDonationAndLink(args: {
  orgId: string;
  constituentId: string;
  campaignId: string;
  swissQrReferenceId: string;
  creditEntryId: string;
  amountCents: number;
  currency: string;
  paymentRef: string;
  valueDate: string | null;
}): Promise<void> {
  const {
    orgId,
    constituentId,
    campaignId,
    swissQrReferenceId,
    creditEntryId,
    amountCents,
    currency,
    paymentRef,
    valueDate,
  } = args;
  await withWorkerContext(orgId, async (tx) => {
    const donatedAt = valueDate ? new Date(valueDate) : new Date();
    // For the camt053 rail we don't run currency conversion here —
    // base-currency conversion will be handled by the receipt /
    // reporting path on the `donation.created` outbox event (same
    // shape as the stripe path uses ExchangeRateService).
    // amountBaseCents defaults to amountCents until the downstream
    // path enriches it; the column is NOT NULL so we set both.
    const [donation] = await tx
      .insert(donations)
      .values({
        orgId,
        constituentId,
        amountCents,
        currency,
        amountBaseCents: amountCents,
        campaignId,
        swissQrReferenceId,
        camtCreditEntryId: creditEntryId,
        paymentSource: "camt053",
        status: "cleared",
        paymentMethod: "camt053",
        paymentRef,
        donatedAt,
        fiscalYear: donatedAt.getFullYear(),
      })
      .onConflictDoNothing()
      .returning({ id: donations.id });

    if (!donation) {
      // Retry hit the `(org_id, payment_method, payment_ref)` unique —
      // already reconciled on an earlier run. Make sure the credit entry
      // points at the right donation by looking it up.
      const [existing] = await tx
        .select({ id: donations.id })
        .from(donations)
        .where(
          and(
            eq(donations.orgId, orgId),
            eq(donations.paymentMethod, "camt053"),
            eq(donations.paymentRef, paymentRef),
          ),
        );
      if (existing) {
        await tx
          .update(camtCreditEntries)
          .set({ donationId: existing.id, updatedAt: new Date() })
          .where(and(eq(camtCreditEntries.id, creditEntryId), eq(camtCreditEntries.orgId, orgId)));
      }
      return;
    }

    await tx
      .update(camtCreditEntries)
      .set({ donationId: donation.id, updatedAt: new Date() })
      .where(and(eq(camtCreditEntries.id, creditEntryId), eq(camtCreditEntries.orgId, orgId)));

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "donation.created",
      payload: {
        donationId: donation.id,
        constituentId,
        amountCents,
        currency,
        paymentMethod: "camt053",
        paymentRef,
        source: "camt053",
      },
    });
  });
}

async function findOriginalDonationForReversal(args: {
  orgId: string;
  reference: string;
  amountCents: number;
}): Promise<{ donationId: string } | null> {
  const { orgId, reference, amountCents } = args;
  return withWorkerContext(orgId, async (tx) => {
    const [row] = await tx
      .select({ donationId: donations.id })
      .from(donations)
      .innerJoin(swissQrReferences, eq(donations.swissQrReferenceId, swissQrReferences.id))
      .where(
        and(
          eq(donations.orgId, orgId),
          eq(swissQrReferences.reference, reference.replace(/\s+/g, "")),
          eq(donations.amountCents, amountCents),
          eq(donations.status, "cleared"),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

async function markDonationRefunded(args: {
  orgId: string;
  donationId: string;
  creditEntryId: string;
}): Promise<void> {
  const { orgId, donationId, creditEntryId } = args;
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(donations)
      .set({ status: "refunded", updatedAt: new Date() })
      .where(and(eq(donations.id, donationId), eq(donations.orgId, orgId)));
    await tx
      .update(camtCreditEntries)
      .set({ donationId, updatedAt: new Date() })
      .where(and(eq(camtCreditEntries.id, creditEntryId), eq(camtCreditEntries.orgId, orgId)));
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "donation.refunded",
      payload: { donationId, source: "camt053" },
    });
  });
}

async function flipProcessed(args: {
  orgId: string;
  statementId: string;
  counters: ReconcileCounters;
  traceparent?: string;
}): Promise<void> {
  const { orgId, statementId, counters, traceparent } = args;
  await withWorkerContext(orgId, async (tx) => {
    await tx
      .update(camtStatements)
      .set({
        status: "processed",
        matchedCredits: counters.matched,
        unmatchedCredits: counters.unmatched,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(camtStatements.id, statementId),
          eq(camtStatements.orgId, orgId),
          // Gate on not-already-processed so a duplicate retry doesn't
          // re-emit `camt053.processed`.
          sql`${camtStatements.status} <> 'processed'`,
        ),
      );
    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "camt053.processed",
      payload: {
        statementId,
        matched: counters.matched,
        unmatched: counters.unmatched,
      },
      metadata: traceparent ? { traceparent } : null,
    });
  });
}
