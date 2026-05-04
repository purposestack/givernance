/** Public donations service — unauthenticated campaign page lookups and Stripe intent creation */

import {
  campaignPublicPages,
  campaignQrCodes,
  campaigns,
  donations,
  tenants,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { db, withTenantContext } from "../../lib/db.js";
import { redis } from "../../lib/redis.js";
import { isUuid } from "../../lib/schemas.js";
import { getStripe } from "../payments/service.js";

/**
 * 30s Redis cache for the public-page payload (issue #193 review,
 * finding #4). The aggregate query (`SUM(amount_base_cents)` +
 * `COUNT(DISTINCT constituent_id)`) is full-scan-prone on a campaign
 * with many donations; a viral campaign drives every visitor through
 * that scan. 30s is short enough that "raised so far" stays
 * recognisably-fresh to a donor and long enough to flatten a Black-
 * Friday-shaped traffic spike. Invalidation is implicit — donations
 * are eventually-consistent on the donor's view, which is fine since
 * the funds have already cleared in Stripe by the time the row exists.
 */
const PUBLIC_PAGE_CACHE_TTL_SECONDS = 30;
const PUBLIC_PAGE_CACHE_PREFIX = "public-page:v1:";

/**
 * Resolve an opaque QR code scanned from a printed campaign letter.
 *
 * The `code` is an opaque nanoid-style token (see worker
 * `campaign-documents.ts` → `generateQrToken`); nothing about the tenant or
 * constituent is encoded in it. Resolution happens here, server-side, so a
 * scanned printout reveals campaign context only to someone who scans it via
 * the Givernance endpoint — not to anyone inspecting the raw PDF.
 *
 * Side-effects: stamps `scanned_at` on first scan (we don't overwrite so the
 * first-contact timestamp survives repeat scans). Returns `null` for unknown
 * codes — the caller turns this into a 404 that does not leak whether the
 * token was ever valid.
 */
export async function resolveCampaignQrCode(code: string) {
  if (!code || code.length < 10 || code.length > 32) {
    return null;
  }

  const [row] = await db
    .select({
      orgId: campaignQrCodes.orgId,
      campaignId: campaignQrCodes.campaignId,
      constituentId: campaignQrCodes.constituentId,
      scannedAt: campaignQrCodes.scannedAt,
    })
    .from(campaignQrCodes)
    .where(eq(campaignQrCodes.code, code));

  if (!row) return null;

  if (!row.scannedAt) {
    await db
      .update(campaignQrCodes)
      .set({ scannedAt: sql`now()` })
      .where(and(eq(campaignQrCodes.code, code), eq(campaignQrCodes.orgId, row.orgId)));
  }

  return {
    orgId: row.orgId,
    campaignId: row.campaignId,
    constituentId: row.constituentId,
  };
}

/** Fetch a published public page by campaign ID (unauthenticated) */
export async function getPublicPage(campaignId: string) {
  if (!isUuid(campaignId)) {
    return null;
  }

  // Cache hit — return the snapshot. We cache the full payload (config +
  // aggregates) since the donate flow is the only consumer and 30s
  // staleness on either piece is acceptable. `null` is cached as the
  // string "404" to distinguish "we know there's no page" from a cache
  // miss; saves DB hits on a scraper hammering unknown campaign ids.
  const cacheKey = `${PUBLIC_PAGE_CACHE_PREFIX}${campaignId}`;
  const cached = await redis.get(cacheKey);
  if (cached === "404") return null;
  if (cached !== null) {
    try {
      return JSON.parse(cached) as Awaited<ReturnType<typeof loadPublicPage>>;
    } catch {
      // Bad JSON — fall through to a fresh fetch + overwrite.
    }
  }

  const fresh = await loadPublicPage(campaignId);
  if (fresh === null) {
    await redis.set(cacheKey, "404", "EX", PUBLIC_PAGE_CACHE_TTL_SECONDS);
  } else {
    await redis.set(cacheKey, JSON.stringify(fresh), "EX", PUBLIC_PAGE_CACHE_TTL_SECONDS);
  }
  return fresh;
}

async function loadPublicPage(campaignId: string) {
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
        // Connect direct-charge requires the browser SDK to bind to the
        // connected account — exposed on this public endpoint so the donor
        // page can both (a) initialise Stripe.js and (b) handle 3DS
        // post-redirect retrieves without round-tripping to the donate
        // endpoint first. `acct_…` ids are public per Stripe docs (issue #197).
        stripeAccountId: tenants.stripeAccountId,
      })
      .from(campaignPublicPages)
      .innerJoin(campaigns, eq(campaigns.id, campaignPublicPages.campaignId))
      .innerJoin(tenants, eq(tenants.id, campaigns.orgId))
      .where(eq(campaignPublicPages.campaignId, campaignId));

    if (!page) return null;

    // Aggregate raised total and donor count for the public hero (issue #200).
    // Cleared donations only — pending/refunded/failed don't count toward the
    // displayed progress. `count(distinct constituent_id)` is the donor-count;
    // anonymous donors get a fresh constituent each so we slightly over-count
    // anonymity, which is the right direction (donors prefer to feel
    // "many people are giving" over an exact-and-lower number).
    const [stats] = await tx
      .select({
        raisedCents: sql<number>`COALESCE(SUM(${donations.amountBaseCents}), 0)::int`,
        donorCount: sql<number>`COUNT(DISTINCT ${donations.constituentId})::int`,
      })
      .from(donations)
      .where(and(eq(donations.campaignId, campaignId), eq(donations.status, "cleared")));

    return {
      ...page,
      raisedCents: stats?.raisedCents ?? 0,
      donorCount: stats?.donorCount ?? 0,
    };
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
    qrCode?: string;
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
    // Platform fee. NOTE for the future refund handler: Stripe's default on
    // direct charges is to keep the application fee on refund — the platform
    // pockets the 1.5%+30¢ even when the donor is fully refunded. To match
    // donor expectations ("I got my €50 back, I didn't pay any fee"), the
    // refund call must pass `refund_application_fee: true`. Tracked in the
    // refund-flow follow-up issue.
    const applicationFeeAmount = calculatePlatformFee(body.amountCents);

    // Epic #274 — resolve the optional QR token server-side so attacker-
    // tainted client input can't smuggle a `qr_code_id` for another tenant
    // into PaymentIntent metadata. We only stash the id once we've verified
    // it belongs to *this* campaign (and therefore this tenant).
    let qrCodeMetadata: { qr_code_id?: string; qr_code_constituent_id?: string } = {};
    if (body.qrCode) {
      const [qr] = await tx
        .select({
          id: campaignQrCodes.id,
          campaignId: campaignQrCodes.campaignId,
          constituentId: campaignQrCodes.constituentId,
        })
        .from(campaignQrCodes)
        .where(
          and(
            eq(campaignQrCodes.code, body.qrCode),
            eq(campaignQrCodes.campaignId, campaignId),
            eq(campaignQrCodes.orgId, campaign.orgId),
          ),
        );
      if (qr) {
        qrCodeMetadata = {
          qr_code_id: qr.id,
          ...(qr.constituentId ? { qr_code_constituent_id: qr.constituentId } : {}),
        };
      }
    }

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
        ...qrCodeMetadata,
      },
    };

    const requestOptions: Parameters<typeof stripe.paymentIntents.create>[1] = {
      stripeAccount: tenant.stripeAccountId,
    };

    if (idempotencyKey) {
      requestOptions.idempotencyKey = idempotencyKey;
    }

    const intent = await stripe.paymentIntents.create(intentParams, requestOptions);

    if (!intent.client_secret) {
      throw new Error("Stripe returned a PaymentIntent without a client_secret");
    }

    // Orphan-PI observability hook (PR #193 review, finding #10): emit a
    // structured `donation_intent.created` log line per PI creation so
    // an ops query of the form
    //   donation_intent.created events without a matching
    //   payment_intent.succeeded webhook within 24h
    // surfaces the donor abandon rate. A donor who closes the tab
    // between `paymentIntents.create` and `confirmPayment` leaves the
    // intent in `requires_payment_method` — Stripe auto-cancels after
    // 7 days, but in the meantime we have no signal to reconcile.
    //
    // Not implemented here: a cleanup worker that explicitly calls
    // `paymentIntents.cancel` on orphans (24h+ stale, no match in our
    // `donations` table). The platform-finance dashboard (#206) is the
    // natural home for the abandon metric and the cleanup job; both are
    // tracked there, deliberately not bundled into this PR.
    //
    // biome-ignore lint/suspicious/noConsole: structured ops log; pino is request-scoped, not in this code path
    console.info(
      JSON.stringify({
        event: "donation_intent.created",
        paymentIntentId: intent.id,
        stripeAccountId: tenant.stripeAccountId,
        campaignId,
        ts: new Date().toISOString(),
      }),
    );

    return {
      clientSecret: intent.client_secret,
      stripeAccountId: tenant.stripeAccountId,
    };
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
