/** Public donations service — unauthenticated campaign page lookups and Stripe intent creation */

import { campaignPublicPages, campaigns, tenants } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { db, withTenantContext } from "../../lib/db.js";
import { isUuid } from "../../lib/schemas.js";
import { getStripe } from "../payments/service.js";

/** Fetch a published public page by campaign ID (unauthenticated) */
export async function getPublicPage(campaignId: string) {
  if (!isUuid(campaignId)) {
    return null;
  }

  // Find the page without RLS to get the orgId.
  // campaign_public_pages does not enforce RLS for reads.
  const [basicPage] = await db
    .select({ orgId: campaignPublicPages.orgId })
    .from(campaignPublicPages)
    .where(
      and(
        eq(campaignPublicPages.campaignId, campaignId),
        eq(campaignPublicPages.status, "published"),
      ),
    );

  if (!basicPage) {
    return null;
  }

  // Query with tenant context to allow joining with campaigns (which has strict RLS)
  return withTenantContext(basicPage.orgId, async (tx) => {
    const [page] = await tx
      .select({
        id: campaignPublicPages.id,
        campaignId: campaignPublicPages.campaignId,
        title: campaignPublicPages.title,
        description: campaignPublicPages.description,
        colorPrimary: campaignPublicPages.colorPrimary,
        goalAmountCents: campaignPublicPages.goalAmountCents,
        defaultCurrency: campaigns.defaultCurrency,
      })
      .from(campaignPublicPages)
      .innerJoin(campaigns, eq(campaigns.id, campaignPublicPages.campaignId))
      .where(eq(campaignPublicPages.campaignId, campaignId));

    return page ?? null;
  });
}

/** Fetch the current public page configuration by campaign ID (admin) */
export async function getAdminPublicPage(orgId: string, campaignId: string) {
  if (!isUuid(campaignId)) {
    return null;
  }

  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const [page] = await tx
      .select()
      .from(campaignPublicPages)
      .where(eq(campaignPublicPages.campaignId, campaignId));

    return page ?? null;
  });
}

/** Platform fee: 1.5% + 30 cents */
function calculatePlatformFee(amountCents: number): number {
  return Math.round(amountCents * 0.015 + 30);
}

/** Create a Stripe PaymentIntent on the tenant's connected account for a public donation */
export async function createDonationIntent(
  campaignId: string,
  body: {
    amountCents: number;
    currency: string;
    email: string;
    firstName: string;
    lastName: string;
  },
  idempotencyKey?: string,
) {
  if (!isUuid(campaignId)) {
    return null;
  }

  const stripe = getStripe();

  // Find the orgId from the public page (readable without RLS)
  const [publicPage] = await db
    .select({ orgId: campaignPublicPages.orgId })
    .from(campaignPublicPages)
    .where(eq(campaignPublicPages.campaignId, campaignId));

  if (!publicPage) return null;

  return withTenantContext(publicPage.orgId, async (tx) => {
    // Look up the campaign to find the default currency (requires RLS context)
    const [campaign] = await tx
      .select({
        id: campaigns.id,
        orgId: campaigns.orgId,
        defaultCurrency: campaigns.defaultCurrency,
      })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));

    if (!campaign) return null;

    // Look up the tenant's Stripe account
    const [tenant] = await tx
      .select({ id: tenants.id, stripeAccountId: tenants.stripeAccountId })
      .from(tenants)
      .where(eq(tenants.id, campaign.orgId));

    if (!tenant?.stripeAccountId) {
      throw new Error("Organization has not completed Stripe onboarding");
    }

    const stripeAccountDetails = await stripe.accounts.retrieve(tenant.stripeAccountId);
    if (!stripeAccountDetails.charges_enabled) {
      throw new Error("Organization Stripe account is not fully onboarded");
    }
    const applicationFeeAmount = calculatePlatformFee(body.amountCents);

    const intentParams: Parameters<typeof stripe.paymentIntents.create>[0] = {
      amount: body.amountCents,
      currency: body.currency.toLowerCase(),
      application_fee_amount: applicationFeeAmount,
      receipt_email: body.email,
      metadata: {
        campaign_id: campaignId,
        org_id: campaign.orgId,
        campaign_default_currency: campaign.defaultCurrency,
        constituent_first_name: body.firstName,
        constituent_last_name: body.lastName,
      },
    };

    const requestOptions: Parameters<typeof stripe.paymentIntents.create>[1] = {
      stripeAccount: tenant.stripeAccountId,
    };

    if (idempotencyKey) {
      requestOptions.idempotencyKey = idempotencyKey;
    }

    const intent = await stripe.paymentIntents.create(intentParams, requestOptions);

    return { clientSecret: intent.client_secret };
  });
}

/** Upsert a public page configuration for a campaign (admin) */
export async function upsertPublicPage(
  orgId: string,
  campaignId: string,
  body: {
    title: string;
    description?: string | null;
    colorPrimary?: string | null;
    goalAmountCents?: number | null;
    status?: "draft" | "published";
  },
) {
  if (!isUuid(campaignId)) {
    return null;
  }

  return withTenantContext(orgId, async (tx) => {
    // Verify campaign belongs to this org
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    // Check for existing page
    const [existing] = await tx
      .select({ id: campaignPublicPages.id })
      .from(campaignPublicPages)
      .where(eq(campaignPublicPages.campaignId, campaignId));

    if (existing) {
      const [updated] = await tx
        .update(campaignPublicPages)
        .set({
          title: body.title,
          description: body.description ?? null,
          colorPrimary: body.colorPrimary ?? null,
          goalAmountCents: body.goalAmountCents ?? null,
          status: body.status ?? "draft",
          updatedAt: new Date(),
        })
        .where(eq(campaignPublicPages.id, existing.id))
        .returning();

      return updated;
    }

    const [created] = await tx
      .insert(campaignPublicPages)
      .values({
        orgId,
        campaignId,
        title: body.title,
        description: body.description ?? null,
        colorPrimary: body.colorPrimary ?? null,
        goalAmountCents: body.goalAmountCents ?? null,
        status: body.status ?? "draft",
      })
      .returning();

    return created;
  });
}
