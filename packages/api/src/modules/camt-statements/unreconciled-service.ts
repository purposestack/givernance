/**
 * camt-unreconciled service (Epic #318 PR #5, docs/25 §6 + §7.bis).
 *
 * Owns the operator review queue:
 *   - list (filtered by bankAccountId / reason / status)
 *   - resolve (`link` | `create_constituent_and_donation` | `write_off`)
 *
 * Every resolution emits an `audit_logs` row with the diff per the
 * audit-trail matrix in docs/25 §7.bis. The constituent + donation
 * creation in the `create_constituent_and_donation` branch reuses the
 * same shape the reconciler creates so a manually-resolved donation
 * is indistinguishable from an auto-reconciled one downstream
 * (receipt PDF generation, reporting, etc.).
 */

import {
  auditLogs,
  type CamtUnreconciledReason,
  type CamtUnreconciledStatus,
  camtCreditEntries,
  camtStatements,
  camtUnreconciledEntries,
  constituents,
  donations,
  outboxEvents,
} from "@givernance/shared/schema";
import type { Pagination } from "@givernance/shared/types";
import { and, count, desc, eq } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface CamtUnreconciledRowOut {
  id: string;
  creditEntryId: string;
  reason: CamtUnreconciledReason;
  status: CamtUnreconciledStatus;
  resolvedAt: string | null;
  resolutionNote: string | null;
  linkedDonationId: string | null;
  createdAt: string;
  creditEntry: {
    statementId: string;
    statementMsgId: string | null;
    amountCents: number;
    currency: string;
    structuredRef: string | null;
    debtorName: string | null;
    debtorIban: string | null;
    bankAccountId: string;
    valueDate: string | null;
  };
}

export interface ListUnreconciledQuery {
  page: number;
  perPage: number;
  bankAccountId?: string;
  reason?: CamtUnreconciledReason;
  status?: CamtUnreconciledStatus;
}

export async function listCamtUnreconciled(
  orgId: string,
  query: ListUnreconciledQuery,
): Promise<{ data: CamtUnreconciledRowOut[]; pagination: Pagination }> {
  return withTenantContext(orgId, async (tx) => {
    const conditions = [eq(camtUnreconciledEntries.orgId, orgId)];
    if (query.reason) conditions.push(eq(camtUnreconciledEntries.reason, query.reason));
    if (query.status) conditions.push(eq(camtUnreconciledEntries.status, query.status));
    if (query.bankAccountId) {
      conditions.push(eq(camtStatements.bankAccountId, query.bankAccountId));
    }
    const where = and(...conditions);
    const offset = (query.page - 1) * query.perPage;

    const baseQuery = tx
      .select({
        id: camtUnreconciledEntries.id,
        creditEntryId: camtUnreconciledEntries.creditEntryId,
        reason: camtUnreconciledEntries.reason,
        status: camtUnreconciledEntries.status,
        resolvedAt: camtUnreconciledEntries.resolvedAt,
        resolutionNote: camtUnreconciledEntries.resolutionNote,
        linkedDonationId: camtUnreconciledEntries.linkedDonationId,
        createdAt: camtUnreconciledEntries.createdAt,
        statementId: camtCreditEntries.statementId,
        statementMsgId: camtStatements.msgId,
        amountCents: camtCreditEntries.amountCents,
        currency: camtCreditEntries.currency,
        structuredRef: camtCreditEntries.structuredRef,
        debtorName: camtCreditEntries.debtorName,
        debtorIban: camtCreditEntries.debtorIban,
        bankAccountId: camtStatements.bankAccountId,
        valueDate: camtCreditEntries.valueDate,
      })
      .from(camtUnreconciledEntries)
      .innerJoin(camtCreditEntries, eq(camtUnreconciledEntries.creditEntryId, camtCreditEntries.id))
      .innerJoin(camtStatements, eq(camtCreditEntries.statementId, camtStatements.id))
      .where(where);

    const [rows, totalRow] = await Promise.all([
      baseQuery
        .orderBy(desc(camtUnreconciledEntries.createdAt))
        .limit(query.perPage)
        .offset(offset),
      tx
        .select({ count: count() })
        .from(camtUnreconciledEntries)
        .innerJoin(
          camtCreditEntries,
          eq(camtUnreconciledEntries.creditEntryId, camtCreditEntries.id),
        )
        .innerJoin(camtStatements, eq(camtCreditEntries.statementId, camtStatements.id))
        .where(where),
    ]);

    const total = Number(totalRow[0]?.count ?? 0);
    return {
      data: rows.map((row) => ({
        id: row.id,
        creditEntryId: row.creditEntryId,
        reason: row.reason,
        status: row.status,
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        resolutionNote: row.resolutionNote,
        linkedDonationId: row.linkedDonationId,
        createdAt: row.createdAt.toISOString(),
        creditEntry: {
          statementId: row.statementId,
          // Mask the placeholder `__pending_*` msg_id (worker hasn't
          // parsed yet) so the operator UI doesn't surface internal
          // bookkeeping. Only "real" MsgIds get rendered.
          statementMsgId: row.statementMsgId?.startsWith("__pending_") ? null : row.statementMsgId,
          amountCents: Number(row.amountCents),
          currency: row.currency,
          structuredRef: row.structuredRef,
          debtorName: row.debtorName,
          debtorIban: row.debtorIban,
          bankAccountId: row.bankAccountId,
          valueDate: row.valueDate,
        },
      })),
      pagination: {
        page: query.page,
        perPage: query.perPage,
        total,
        totalPages: Math.ceil(total / query.perPage),
      },
    };
  });
}

export class CamtUnreconciledNotFoundError extends Error {
  constructor(id: string) {
    super(`Unreconciled entry ${id} not found`);
    this.name = "CamtUnreconciledNotFoundError";
  }
}

export class CamtUnreconciledResolveError extends Error {
  public readonly code:
    | "already_resolved"
    | "missing_donation_id"
    | "missing_constituent_id"
    | "donation_not_found"
    | "constituent_not_found";
  constructor(
    code:
      | "already_resolved"
      | "missing_donation_id"
      | "missing_constituent_id"
      | "donation_not_found"
      | "constituent_not_found",
    message: string,
  ) {
    super(message);
    this.name = "CamtUnreconciledResolveError";
    this.code = code;
  }
}

export interface ResolveInput {
  orgId: string;
  id: string;
  action: "link" | "create_constituent_and_donation" | "write_off";
  resolutionNote: string;
  donationId?: string;
  constituentId?: string;
  /**
   * Resolved `users.id` row UUID (`request.auth.userRowId`) — written to
   * the `camt_unreconciled_entries.resolved_by` FK. Epic #363 split
   * `users.id` from the Keycloak `sub`, so the JWT subject is NOT a valid
   * `users.id`. `null` for actors with no tenant `users` row.
   */
  resolvedByRowId: string | null;
  /** JWT `sub` (Keycloak id) — recorded on the varchar `audit_logs.user_id`. */
  resolvedByUserId: string | null;
  /** RFC 8693 `act.sub` (impersonator Keycloak id) for the audit row. */
  effectiveActorId: string | null;
}

interface DispatchedAction {
  linkedDonationId: string | null;
  newStatus: CamtUnreconciledStatus;
}

interface DispatchArgs {
  tx: Parameters<Parameters<typeof withTenantContext>[1]>[0];
  input: ResolveInput;
  existing: { id: string; creditEntryId: string };
  creditEntry: {
    id: string;
    amountCents: number;
    currency: string;
    acctSvcrRef: string;
    valueDate: string | null;
  };
}

/**
 * Resolve one of the three actions. Extracted from `resolveCamtUnreconciled`
 * to keep that function under the biome cognitive-complexity ceiling.
 */
async function dispatchResolveAction(args: DispatchArgs): Promise<DispatchedAction> {
  const { input } = args;
  if (input.action === "link") {
    return handleLinkAction(args);
  }
  if (input.action === "create_constituent_and_donation") {
    return handleCreateAction(args);
  }
  // `write_off` — terminal status flip with no side-effect on donations.
  return { linkedDonationId: null, newStatus: "written_off" };
}

async function handleLinkAction(args: DispatchArgs): Promise<DispatchedAction> {
  const { tx, input, existing } = args;
  const donationId = input.donationId ?? "";
  const [donation] = await tx
    .select({ id: donations.id })
    .from(donations)
    .where(and(eq(donations.id, donationId), eq(donations.orgId, input.orgId)));
  if (!donation) {
    throw new CamtUnreconciledResolveError(
      "donation_not_found",
      `Donation ${input.donationId} not found for this org.`,
    );
  }
  await tx
    .update(camtCreditEntries)
    .set({ donationId: donation.id, updatedAt: new Date() })
    .where(
      and(
        eq(camtCreditEntries.id, existing.creditEntryId),
        eq(camtCreditEntries.orgId, input.orgId),
      ),
    );
  return { linkedDonationId: donation.id, newStatus: "resolved" };
}

async function handleCreateAction(args: DispatchArgs): Promise<DispatchedAction> {
  const { tx, input, creditEntry } = args;
  const constituentId = input.constituentId ?? "";
  const [constituent] = await tx
    .select({ id: constituents.id })
    .from(constituents)
    .where(and(eq(constituents.id, constituentId), eq(constituents.orgId, input.orgId)));
  if (!constituent) {
    throw new CamtUnreconciledResolveError(
      "constituent_not_found",
      `Constituent ${input.constituentId} not found for this org.`,
    );
  }
  const donatedAt = creditEntry.valueDate ? new Date(creditEntry.valueDate) : new Date();
  const amount = Number(creditEntry.amountCents);
  const [created] = await tx
    .insert(donations)
    .values({
      orgId: input.orgId,
      constituentId: constituent.id,
      amountCents: amount,
      amountBaseCents: amount,
      currency: creditEntry.currency,
      paymentSource: "camt053",
      status: "cleared",
      // Distinct paymentMethod (`camt053_manual`) so reporting can split
      // "auto-matched" from "operator-resolved" if needed.
      paymentMethod: "camt053_manual",
      paymentRef: creditEntry.acctSvcrRef,
      camtCreditEntryId: creditEntry.id,
      donatedAt,
      fiscalYear: donatedAt.getFullYear(),
    })
    .onConflictDoNothing()
    .returning({ id: donations.id });

  if (!created) {
    // Race: another operator just resolved, or worker retry beat us.
    const [existingDonation] = await tx
      .select({ id: donations.id })
      .from(donations)
      .where(
        and(
          eq(donations.orgId, input.orgId),
          eq(donations.paymentMethod, "camt053_manual"),
          eq(donations.paymentRef, creditEntry.acctSvcrRef),
        ),
      );
    return { linkedDonationId: existingDonation?.id ?? null, newStatus: "resolved" };
  }

  await tx
    .update(camtCreditEntries)
    .set({ donationId: created.id, updatedAt: new Date() })
    .where(and(eq(camtCreditEntries.id, creditEntry.id), eq(camtCreditEntries.orgId, input.orgId)));
  await tx.insert(outboxEvents).values({
    tenantId: input.orgId,
    type: "donation.created",
    payload: {
      donationId: created.id,
      constituentId: constituent.id,
      amountCents: amount,
      currency: creditEntry.currency,
      paymentMethod: "camt053_manual",
      paymentRef: creditEntry.acctSvcrRef,
      source: "camt053_manual",
    },
  });
  return { linkedDonationId: created.id, newStatus: "resolved" };
}

export async function resolveCamtUnreconciled(
  input: ResolveInput,
): Promise<CamtUnreconciledRowOut> {
  // Pre-validate the action shape outside the transaction.
  if (input.action === "link" && !input.donationId) {
    throw new CamtUnreconciledResolveError(
      "missing_donation_id",
      "`link` action requires `donationId`.",
    );
  }
  if (input.action === "create_constituent_and_donation" && !input.constituentId) {
    throw new CamtUnreconciledResolveError(
      "missing_constituent_id",
      "`create_constituent_and_donation` requires `constituentId` (operator confirmed donor).",
    );
  }

  return withTenantContext(input.orgId, async (tx) => {
    const [existing] = await tx
      .select({
        id: camtUnreconciledEntries.id,
        creditEntryId: camtUnreconciledEntries.creditEntryId,
        status: camtUnreconciledEntries.status,
        reason: camtUnreconciledEntries.reason,
      })
      .from(camtUnreconciledEntries)
      .where(
        and(
          eq(camtUnreconciledEntries.id, input.id),
          eq(camtUnreconciledEntries.orgId, input.orgId),
        ),
      );
    if (!existing) throw new CamtUnreconciledNotFoundError(input.id);
    if (existing.status !== "pending") {
      throw new CamtUnreconciledResolveError(
        "already_resolved",
        `Entry already in status=${existing.status}`,
      );
    }

    const [creditEntry] = await tx
      .select({
        id: camtCreditEntries.id,
        amountCents: camtCreditEntries.amountCents,
        currency: camtCreditEntries.currency,
        acctSvcrRef: camtCreditEntries.acctSvcrRef,
        valueDate: camtCreditEntries.valueDate,
      })
      .from(camtCreditEntries)
      .where(
        and(
          eq(camtCreditEntries.id, existing.creditEntryId),
          eq(camtCreditEntries.orgId, input.orgId),
        ),
      );
    if (!creditEntry) {
      throw new CamtUnreconciledNotFoundError(existing.creditEntryId);
    }

    const dispatched = await dispatchResolveAction({
      tx,
      input,
      existing,
      creditEntry,
    });
    const linkedDonationId = dispatched.linkedDonationId;
    const newStatus = dispatched.newStatus;

    // Flip the queue row.
    const [updated] = await tx
      .update(camtUnreconciledEntries)
      .set({
        status: newStatus,
        // FK → users.id — must be the resolved row id (Epic #363 split
        // users.id from the JWT sub); the audit row keeps the sub + act.sub.
        resolvedBy: input.resolvedByRowId,
        resolvedAt: new Date(),
        resolutionNote: input.resolutionNote,
        linkedDonationId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(camtUnreconciledEntries.id, input.id),
          eq(camtUnreconciledEntries.orgId, input.orgId),
        ),
      )
      .returning();
    if (!updated) {
      throw new CamtUnreconciledNotFoundError(input.id);
    }

    // Audit row — domain shape (the plugin row is fired automatically
    // by the API plugin on every mutating request).
    await tx.insert(auditLogs).values({
      orgId: input.orgId,
      userId: input.resolvedByUserId ?? "",
      actorId: input.effectiveActorId ?? null,
      action: `DOMAIN:camt_unreconciled_entry.${
        input.action === "write_off" ? "write_off" : "resolve"
      }`,
      resourceType: "camt_unreconciled_entry",
      resourceId: input.id,
      oldValues: { status: existing.status, reason: existing.reason },
      newValues: {
        status: newStatus,
        action: input.action,
        resolutionNote: input.resolutionNote,
        linkedDonationId,
      },
    });

    // Re-fetch the row with the credit-entry context to return the
    // freshly-resolved shape (mirrors the list endpoint).
    const [enriched] = await tx
      .select({
        id: camtUnreconciledEntries.id,
        creditEntryId: camtUnreconciledEntries.creditEntryId,
        reason: camtUnreconciledEntries.reason,
        status: camtUnreconciledEntries.status,
        resolvedAt: camtUnreconciledEntries.resolvedAt,
        resolutionNote: camtUnreconciledEntries.resolutionNote,
        linkedDonationId: camtUnreconciledEntries.linkedDonationId,
        createdAt: camtUnreconciledEntries.createdAt,
        statementId: camtCreditEntries.statementId,
        statementMsgId: camtStatements.msgId,
        amountCents: camtCreditEntries.amountCents,
        currency: camtCreditEntries.currency,
        structuredRef: camtCreditEntries.structuredRef,
        debtorName: camtCreditEntries.debtorName,
        debtorIban: camtCreditEntries.debtorIban,
        bankAccountId: camtStatements.bankAccountId,
        valueDate: camtCreditEntries.valueDate,
      })
      .from(camtUnreconciledEntries)
      .innerJoin(camtCreditEntries, eq(camtUnreconciledEntries.creditEntryId, camtCreditEntries.id))
      .innerJoin(camtStatements, eq(camtCreditEntries.statementId, camtStatements.id))
      .where(eq(camtUnreconciledEntries.id, updated.id));
    if (!enriched) throw new CamtUnreconciledNotFoundError(input.id);

    return {
      id: enriched.id,
      creditEntryId: enriched.creditEntryId,
      reason: enriched.reason,
      status: enriched.status,
      resolvedAt: enriched.resolvedAt?.toISOString() ?? null,
      resolutionNote: enriched.resolutionNote,
      linkedDonationId: enriched.linkedDonationId,
      createdAt: enriched.createdAt.toISOString(),
      creditEntry: {
        statementId: enriched.statementId,
        statementMsgId: enriched.statementMsgId?.startsWith("__pending_")
          ? null
          : enriched.statementMsgId,
        amountCents: Number(enriched.amountCents),
        currency: enriched.currency,
        structuredRef: enriched.structuredRef,
        debtorName: enriched.debtorName,
        debtorIban: enriched.debtorIban,
        bankAccountId: enriched.bankAccountId,
        valueDate: enriched.valueDate,
      },
    };
  });
}
