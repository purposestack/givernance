/** Pledges service — business logic for pledge and installment operations */

import {
  constituents,
  type OutboxMetadata,
  outboxEvents,
  pledgeInstallments,
  pledges,
} from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { withTenantContext } from "../../lib/db.js";
import { buildOutboxMetadata } from "../../lib/trace-context.js";

export interface PledgeInput {
  constituentId: string;
  amountCents: number;
  currency?: string;
  frequency: "monthly" | "yearly";
  stripeCustomerId?: string;
  stripeAccountId?: string;
  paymentGateway?: string;
}

/**
 * Expected dates for the first year of installments: 12 monthly or 1 yearly,
 * starting one period after `from`.
 *
 * UTC arithmetic with the day clamped to the last day of the target month
 * (issue #611). `Date#setMonth` overflows instead — Jan 31 + 1 month lands on
 * Mar 3, so a pledge created on the 31st skipped Feb / Apr / Jun / Sep / Nov
 * and doubled up on the following month. Each date is derived from `from`
 * (never from the previous installment), so a clamp in February does not
 * drag the March installment back to the 28th.
 */
export function buildInstallmentDates(from: Date, frequency: "monthly" | "yearly"): Date[] {
  const count = frequency === "monthly" ? 12 : 1;
  const dates: Date[] = [];
  for (let i = 1; i <= count; i++) {
    const monthsAhead = frequency === "monthly" ? i : i * 12;
    const targetMonthIndex = from.getUTCMonth() + monthsAhead;
    // Day 0 of the month AFTER the target = last day of the target month.
    const lastDayOfTarget = new Date(
      Date.UTC(from.getUTCFullYear(), targetMonthIndex + 1, 0),
    ).getUTCDate();
    dates.push(
      new Date(
        Date.UTC(
          from.getUTCFullYear(),
          targetMonthIndex,
          Math.min(from.getUTCDate(), lastDayOfTarget),
          from.getUTCHours(),
          from.getUTCMinutes(),
          from.getUTCSeconds(),
          from.getUTCMilliseconds(),
        ),
      ),
    );
  }
  return dates;
}

/**
 * Create a pledge and generate the first year of installments.
 *
 * @returns the pledge, or `null` when the constituent is unknown, soft-deleted
 *   or belongs to another tenant (route → 404).
 */
export async function createPledge(
  orgId: string,
  userId: string,
  input: PledgeInput,
  request?: FastifyRequest,
) {
  // W3C trace-context → outbox metadata (issue #55); null outside an HTTP request.
  const metadata: OutboxMetadata | null = request ? buildOutboxMetadata(request) : null;

  return withTenantContext(orgId, async (tx) => {
    // Verify the constituent belongs to this tenant (FK checks bypass RLS, so
    // the FK alone would accept another tenant's id; an unknown id would
    // surface as a 500). Mirrors `createDonation` — issue #611.
    const [constituent] = await tx
      .select({ id: constituents.id })
      .from(constituents)
      .where(
        and(
          eq(constituents.id, input.constituentId),
          eq(constituents.orgId, orgId),
          isNull(constituents.deletedAt),
        ),
      );

    if (!constituent) return null;

    const [pledge] = await tx
      .insert(pledges)
      .values({
        orgId,
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency: input.currency ?? "EUR",
        // 1:1 fallback when currency == tenant base; multi-currency pledge FX is roadmap (docs/30 §8).
        amountBaseCents: input.amountCents,
        frequency: input.frequency,
        stripeCustomerId: input.stripeCustomerId,
        stripeAccountId: input.stripeAccountId,
        paymentGateway: input.paymentGateway,
      })
      .returning();

    // biome-ignore lint/style/noNonNullAssertion: insert().returning() always returns a row
    const pledgeId = pledge!.id;

    // Generate first year of installments
    const installmentValues = buildInstallmentDates(new Date(), input.frequency).map(
      (expectedAt) => ({
        orgId,
        pledgeId,
        expectedAt,
        // Per-installment amount (issue #56 Data #6). Variable / bumped
        // installments set this to a different value per row; for the
        // first-year scaffold generated here every installment mirrors the
        // pledge amount so reconciliation against donations is straightforward.
        amountCents: input.amountCents,
      }),
    );

    await tx.insert(pledgeInstallments).values(installmentValues);

    await tx.insert(outboxEvents).values({
      tenantId: orgId,
      type: "pledge.created",
      payload: {
        pledgeId,
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        frequency: input.frequency,
        createdBy: userId,
      },
      metadata,
    });

    return pledge;
  });
}

/** Get a pledge by ID */
export async function getPledge(orgId: string, id: string) {
  return withTenantContext(orgId, async (tx) => {
    const [pledge] = await tx
      .select()
      .from(pledges)
      .where(and(eq(pledges.id, id), eq(pledges.orgId, orgId)));

    return pledge ?? null;
  });
}

/** List installments for a given pledge */
export async function listInstallments(orgId: string, pledgeId: string) {
  return withTenantContext(orgId, async (tx) => {
    // Verify the pledge belongs to this org
    const [pledge] = await tx
      .select({ id: pledges.id })
      .from(pledges)
      .where(and(eq(pledges.id, pledgeId), eq(pledges.orgId, orgId)));

    if (!pledge) return null;

    const data = await tx
      .select()
      .from(pledgeInstallments)
      // Issue #430 — explicit org filter for defence in depth.
      .where(and(eq(pledgeInstallments.pledgeId, pledgeId), eq(pledgeInstallments.orgId, orgId)))
      .orderBy(pledgeInstallments.expectedAt);

    return data;
  });
}
