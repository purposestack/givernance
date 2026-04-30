/** Public donations service — unauthenticated campaign page lookups and gateway-dispatched intent creation */

import {
  campaignPublicPages,
  campaignQrCodes,
  campaigns,
  donations,
  type PaymentGatewayKey,
  tenants,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { db, withTenantContext } from "../../lib/db.js";
import type { CreateDonationIntentResult } from "../../lib/payments/gateway.interface.js";
import {
  getGatewayForTenant,
  PaymentGatewayUnavailableError,
} from "../../lib/payments/gateway-factory.js";
import { redis } from "../../lib/redis.js";
import { isUuid } from "../../lib/schemas.js";

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
        /**
         * Tenant's selected gateway. The donor frontend branches on this
         * to render Stripe Elements (`'stripe'`), a Mollie redirect button
         * (`'mollie'`), or a "this org takes offline donations" fallback
         * (`'manual'`). Returned on the public page so the form can
         * differentiate before the donor submits.
         */
        paymentGateway: tenants.paymentGateway,
        // Connect direct-charge requires the browser SDK to bind to the
        // connected account — exposed on this public endpoint so the donor
        // page can both (a) initialise Stripe.js and (b) handle 3DS
        // post-redirect retrieves without round-tripping to the donate
        // endpoint first. `acct_…` ids are public per Stripe docs (issue #197).
        // Null when the tenant uses Mollie or has not onboarded yet.
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

export type CreateDonationIntentOutcome =
  | { kind: "ok"; result: CreateDonationIntentResult }
  | { kind: "not_found" }
  | { kind: "gateway_unavailable"; reason: PaymentGatewayUnavailableError["reason"] };

/**
 * Create a payment intent on the tenant's selected gateway (issue #62).
 *
 * Dispatch flow:
 *   1. Resolve the public page → tenant
 *   2. Build a `PaymentGateway` via `getGatewayForTenant` (which checks
 *      the `ff.payments.mollie` flag for Mollie tenants, the
 *      `stripeAccountId` for Stripe, etc.)
 *   3. Delegate to `gateway.createDonationIntent(...)` with the donor
 *      details + URLs the gateway needs (Mollie wants `webhookUrl` and
 *      `redirectUrl`; Stripe doesn't, but the interface stays uniform).
 *
 * The return shape is the discriminated union the gateway emits — the
 * route turns this into the donor-frontend response. `gateway_unavailable`
 * surfaces the structured reason so the route can map to a specific
 * problem-detail message ("Mollie not configured" vs. "Stripe not
 * onboarded" vs. "Org uses manual reconciliation").
 */
export async function createDonationIntent(
  campaignId: string,
  body: {
    amountCents: number;
    currency: string;
    email: string;
    firstName: string;
    lastName: string;
  },
  options: {
    idempotencyKey?: string;
    /** Public donor-page URL — Mollie redirects donors back here after checkout. */
    returnUrl: string;
    /** Public webhook URL Mollie POSTs to on payment status changes. */
    webhookUrl: string;
  },
): Promise<CreateDonationIntentOutcome> {
  if (!isUuid(campaignId)) {
    return { kind: "not_found" };
  }

  // Find the orgId from the public page (readable without RLS)
  const [publicPage] = await db
    .select({ orgId: campaignPublicPages.orgId })
    .from(campaignPublicPages)
    .where(eq(campaignPublicPages.campaignId, campaignId));

  if (!publicPage) return { kind: "not_found" };

  return withTenantContext(publicPage.orgId, async (tx): Promise<CreateDonationIntentOutcome> => {
    // Look up the campaign to find the default currency (requires RLS context)
    const [campaign] = await tx
      .select({
        id: campaigns.id,
        orgId: campaigns.orgId,
        defaultCurrency: campaigns.defaultCurrency,
      })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));

    if (!campaign) return { kind: "not_found" };

    // Look up the tenant's gateway selection + per-gateway credentials.
    const [tenant] = await tx
      .select({
        id: tenants.id,
        paymentGateway: tenants.paymentGateway,
        stripeAccountId: tenants.stripeAccountId,
        mollieApiKey: tenants.mollieApiKey,
        featureFlags: tenants.featureFlags,
      })
      .from(tenants)
      .where(eq(tenants.id, campaign.orgId));

    if (!tenant) return { kind: "not_found" };

    let gateway: ReturnType<typeof getGatewayForTenant>;
    try {
      gateway = getGatewayForTenant(tenant);
    } catch (err) {
      if (err instanceof PaymentGatewayUnavailableError) {
        return { kind: "gateway_unavailable", reason: err.reason };
      }
      throw err;
    }

    // Platform fee. NOTE for the future refund handler: Stripe's default on
    // direct charges is to keep the application fee on refund — the platform
    // pockets the 1.5%+30¢ even when the donor is fully refunded. To match
    // donor expectations ("I got my €50 back, I didn't pay any fee"), the
    // refund call must pass `refund_application_fee: true`. Tracked in the
    // refund-flow follow-up issue.
    const applicationFeeAmount = calculatePlatformFee(body.amountCents);

    const result = await gateway.createDonationIntent({
      campaignId,
      currency: body.currency,
      amountCents: body.amountCents,
      applicationFeeAmountCents: applicationFeeAmount,
      donor: {
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
      },
      idempotencyKey: options.idempotencyKey,
      returnUrl: options.returnUrl,
      webhookUrl: options.webhookUrl,
    });

    // Orphan observability hook (PR #193 review, finding #10): one structured
    // line per intent creation so an ops query of the form
    //   donation_intent.created events without a matching gateway-success
    //   webhook within 24h
    // surfaces the donor abandon rate, regardless of which gateway was used.
    //
    // biome-ignore lint/suspicious/noConsole: structured ops log; pino is request-scoped, not in this code path
    console.info(
      JSON.stringify({
        event: "donation_intent.created",
        provider: result.provider,
        campaignId,
        ts: new Date().toISOString(),
        ...(result.provider === "stripe"
          ? { stripeAccountId: result.stripeAccountId }
          : { molliePaymentId: result.molliePaymentId }),
      }),
    );

    return { kind: "ok", result };
  });
}

/** Re-export the discriminated union so the route + frontend share a single source of truth. */
export type { CreateDonationIntentResult, PaymentGatewayKey };

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
