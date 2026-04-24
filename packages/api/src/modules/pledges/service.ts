/** Pledges service — business logic for pledge and installment operations */

import { outboxEvents, pledgeInstallments, pledges } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { withTenantContext } from "../../lib/db.js";

export interface PledgeInput {
  constituentId: string;
  amountCents: number;
  currency?: string;
  frequency: "monthly" | "yearly";
  stripeCustomerId?: string;
  stripeAccountId?: string;
  paymentGateway?: string;
}

/** Create a pledge and generate the first year of installments */
export async function createPledge(orgId: string, userId: string, input: PledgeInput) {
  return withTenantContext(orgId, async (tx) => {
    const [pledge] = await tx
      .insert(pledges)
      .values({
        orgId,
        constituentId: input.constituentId,
        amountCents: input.amountCents,
        currency: input.currency ?? "EUR",
        frequency: input.frequency,
        stripeCustomerId: input.stripeCustomerId,
        stripeAccountId: input.stripeAccountId,
        paymentGateway: input.paymentGateway,
      })
      .returning();

    // biome-ignore lint/style/noNonNullAssertion: insert().returning() always returns a row
    const pledgeId = pledge!.id;

    // Generate first year of installments
    const count = input.frequency === "monthly" ? 12 : 1;
    const now = new Date();
    const installmentValues = [];

    for (let i = 0; i < count; i++) {
      const expectedAt = new Date(now);
      if (input.frequency === "monthly") {
        expectedAt.setMonth(expectedAt.getMonth() + i + 1);
      } else {
        expectedAt.setFullYear(expectedAt.getFullYear() + i + 1);
      }
      installmentValues.push({
        orgId,
        pledgeId,
        expectedAt,
        // Per-installment amount (issue #56 Data #6). Variable / bumped
        // installments set this to a different value per row; for the
        // first-year scaffold generated here every installment mirrors the
        // pledge amount so reconciliation against donations is straightforward.
        amountCents: input.amountCents,
      });
    }

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
      .where(eq(pledgeInstallments.pledgeId, pledgeId))
      .orderBy(pledgeInstallments.expectedAt);

    return data;
  });
}
