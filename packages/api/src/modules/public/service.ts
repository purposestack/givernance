/** Public donations service — unauthenticated campaign page lookups and Stripe intent creation */

import {
  DEFAULT_PUBLIC_PAGE_STYLE,
  FEATURE_FLAG_KEYS,
  isPublicPageStyleKey,
  type PublicPageStyleKey,
} from "@givernance/shared/constants";
import {
  type BrandingAssetVariants,
  campaignPublicPages,
  campaignQrCodes,
  campaigns,
  donations,
  orgBrandingAssets,
  tenants,
} from "@givernance/shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, systemDb, withTenantContext } from "../../lib/db.js";
import { flagService } from "../../lib/flags/flag-service.js";
import { redis } from "../../lib/redis.js";
import { brandingPublicUrl } from "../../lib/s3.js";
import { isUuid } from "../../lib/schemas.js";
import { getStripe } from "../payments/service.js";

/**
 * Three-layer resolution of the donor-facing archetype (Epic #362).
 *
 *   campaign-level override ?? tenant-level default ?? "foundation"
 *
 * `isPublicPageStyleKey` defends against a stale DB value surviving a
 * removed-archetype migration (defence-in-depth — the validator already
 * rejects unknown values on write, but a soft-deleted archetype could
 * leave a dangling row). An unrecognised value falls all the way back
 * to the platform default rather than 404-ing the donor's page.
 */
function resolvePublicPageStyle(
  campaignStyle: string | null | undefined,
  tenantDefault: string | null | undefined,
): PublicPageStyleKey {
  if (isPublicPageStyleKey(campaignStyle)) return campaignStyle;
  if (isPublicPageStyleKey(tenantDefault)) return tenantDefault;
  return DEFAULT_PUBLIC_PAGE_STYLE;
}

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

  // Cross-tenant lookup by opaque token. The endpoint is public + un-
  // authenticated, so there is no `app.current_organization_id` to set
  // for RLS — running this through the app pool (`db`, NOBYPASSRLS)
  // would silently return zero rows because `campaign_qr_codes` has
  // FORCE ROW LEVEL SECURITY (`org_id = app_current_organization_id()`).
  // The 120-bit opaque code itself IS the security boundary here: an
  // attacker can't forge a valid one without scraping a printed letter,
  // and rate-limiting on the route bounds a brute-force attempt.
  const [row] = await systemDb
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
    // Atomic guard against concurrent first-scans: two scans landing
    // between the SELECT above and this UPDATE would each see
    // `scannedAt IS NULL` and both would write `scannedAt = now()`,
    // overwriting the genuine first-contact timestamp. The DB-level
    // `scanned_at IS NULL` filter makes the UPDATE a no-op for the
    // loser of the race, preserving "first scan wins" semantics.
    await systemDb
      .update(campaignQrCodes)
      .set({ scannedAt: sql`now()` })
      .where(
        and(
          eq(campaignQrCodes.code, code),
          eq(campaignQrCodes.orgId, row.orgId),
          isNull(campaignQrCodes.scannedAt),
        ),
      );
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

  // Cache hit — return the snapshot. The cached payload carries the
  // *raw* per-campaign + per-tenant style columns (not the flag-
  // resolved `publicPageStyle`); flag evaluation and the three-layer
  // fallback resolution happen below, AFTER the cache read. This is
  // the load-bearing fix for the flag-flip residual: a super-admin
  // flipping `donation.public_page_styles` mid-cache window is picked
  // up on the very next read instead of being shadowed by a stale
  // cache entry for up to 30 s (PR-2 multi-agent review, security #4
  // + backend I4). The flag service has its own Redis → PG cache so
  // the extra check is sub-millisecond in steady state.
  const cacheKey = `${PUBLIC_PAGE_CACHE_PREFIX}${campaignId}`;
  const cached = await redis.get(cacheKey);
  if (cached === "404") return null;

  let raw: Awaited<ReturnType<typeof loadPublicPage>> = null;
  if (cached !== null) {
    try {
      raw = JSON.parse(cached) as Awaited<ReturnType<typeof loadPublicPage>>;
    } catch {
      // Bad JSON — fall through to a fresh fetch + overwrite.
      raw = null;
    }
  }
  if (raw === null) {
    raw = await loadPublicPage(campaignId);
    if (raw === null) {
      await redis.set(cacheKey, "404", "EX", PUBLIC_PAGE_CACHE_TTL_SECONDS);
      return null;
    }
    await redis.set(cacheKey, JSON.stringify(raw), "EX", PUBLIC_PAGE_CACHE_TTL_SECONDS);
  }

  // Resolve the donor-facing `publicPageStyle` outside the cached
  // payload — flagService.isEnabled is Redis-cached so this is a
  // sub-millisecond hop. With the flag off the field is null and the
  // donor-page shell falls back to today's hardcoded layout. With
  // the flag on, the three-layer fallback (campaign override → tenant
  // default → "foundation") runs against the cached raw columns.
  const styleEnabled = await flagService.isEnabled(FEATURE_FLAG_KEYS.DONATION_PUBLIC_PAGE_STYLES, {
    orgId: raw.orgIdForStyleResolution,
  });
  const {
    orgIdForStyleResolution: _,
    campaignPublicPageStyle,
    tenantDefaultPublicPageStyle,
    ...rest
  } = raw;
  return {
    ...rest,
    publicPageStyle: styleEnabled
      ? resolvePublicPageStyle(campaignPublicPageStyle, tenantDefaultPublicPageStyle)
      : null,
  };
}

async function loadPublicPage(campaignId: string) {
  // campaign_public_pages does not enforce RLS for reads — we
  // resolve `orgId` first, then enter `withTenantContext` for the
  // joins on tables that DO enforce RLS.
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
         * Per-campaign style override + tenant default (Epic #362).
         * Both are nullable on the schema; the three-layer resolution
         * happens in `resolveDonorFacingStyle` after the join.
         */
        campaignPublicPageStyle: campaigns.publicPageStyle,
        tenantDefaultPublicPageStyle: tenants.defaultPublicPageStyle,
        // Connect direct-charge requires the browser SDK to bind to the
        // connected account — exposed on this public endpoint so the donor
        // page can both (a) initialise Stripe.js and (b) handle 3DS
        // post-redirect retrieves without round-tripping to the donate
        // endpoint first. `acct_…` ids are public per Stripe docs (issue #197).
        stripeAccountId: tenants.stripeAccountId,
        // Org identity for the public hero (Epic #274 follow-up). Without
        // these the page reads as "generic donation form on the internet"
        // — donors need to recognise the organisation they're giving to.
        // Both fields are already public-by-design on the operator side
        // (org name appears on every printed letter; mission is a
        // donor-facing pitch line). No PII risk.
        organisationId: tenants.id,
        organisationName: tenants.name,
        organisationMission: tenants.mission,
        // Epic #318 — boolean discriminator for the donor-facing "you
        // can also pay via the QR-bill on your printed letter" banner.
        // We return a boolean (not the bank_account_id) so no internal
        // identifier leaks onto the public surface.
        bankAccountId: campaigns.bankAccountId,
        // Active org-logo (Epic #286). LEFT JOIN — the donor page renders
        // an initial-letter avatar fallback (seeded by `organisationId`)
        // when the tenant hasn't uploaded a logo, so a missing row is the
        // expected hot path, not an error. Filter on `status='ready'` +
        // `deleted_at IS NULL` so a soft-deleted or in-flight asset never
        // leaks a half-built variant set onto a donor-facing surface.
        logoVariants: orgBrandingAssets.variants,
      })
      .from(campaignPublicPages)
      .innerJoin(
        campaigns,
        and(eq(campaigns.id, campaignPublicPages.campaignId), eq(campaigns.orgId, basicPage.orgId)),
      )
      .innerJoin(tenants, eq(tenants.id, campaigns.orgId))
      .leftJoin(
        orgBrandingAssets,
        and(
          eq(orgBrandingAssets.id, tenants.logoAssetId),
          eq(orgBrandingAssets.orgId, basicPage.orgId),
          eq(orgBrandingAssets.status, "ready"),
          isNull(orgBrandingAssets.deletedAt),
        ),
      )
      // Defence in depth (issue #430): explicit orgId predicate on the
      // root table so the cross-table join chain cannot fall back to
      // RLS alone for tenant scoping.
      .where(
        and(
          eq(campaignPublicPages.orgId, basicPage.orgId),
          eq(campaignPublicPages.campaignId, campaignId),
        ),
      );

    if (!page) return null;

    // Project the `public-hero` variant URL for the donor page. Falls
    // back to `null` when no logo is configured (or the variant is
    // missing from a corrupted row) — the frontend renders the
    // initial-letter avatar fallback in that case. Drizzle types
    // `variants` as `BrandingAssetVariants | null` from the schema's
    // `$type<…>()` annotation, so no runtime cast is needed.
    const variants: BrandingAssetVariants | null = page.logoVariants;
    const heroVariantKey = variants?.["public-hero"]?.key;
    const organisationLogoUrl = heroVariantKey ? brandingPublicUrl(heroVariantKey) : null;

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
      // Defence in depth (issue #430): explicit org filter so the
      // public-page hero stats can never sum donations from another
      // tenant if the campaign_id was ever leaked or guessed.
      .where(
        and(
          eq(donations.orgId, basicPage.orgId),
          eq(donations.campaignId, campaignId),
          eq(donations.status, "cleared"),
        ),
      );

    // Strip the internal `logoVariants` + raw `bankAccountId` from
    // the cached shape. The two raw style columns survive into the
    // cache untouched — `getPublicPage` resolves them against the
    // current flag state at the read boundary, so a flag flip is
    // visible to donors on the next request rather than after the
    // 30 s cache TTL.
    const { logoVariants: _logoVariants, bankAccountId: _ba, ...rest } = page;
    return {
      ...rest,
      raisedCents: stats?.raisedCents ?? 0,
      donorCount: stats?.donorCount ?? 0,
      organisationLogoUrl,
      hasSwissQrBill: page.bankAccountId !== null,
      // `getPublicPage` needs this to evaluate the per-tenant flag at
      // the boundary; stripped from the donor-facing response there.
      orgIdForStyleResolution: basicPage.orgId,
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
      .select({
        id: campaigns.id,
        // Per-campaign archetype override (Epic #362). The admin view
        // sees the raw value (NULL = "inherits from tenant"); the
        // donor-facing endpoint resolves the three-layer fallback.
        publicPageStyle: campaigns.publicPageStyle,
      })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    const [page] = await tx
      .select()
      .from(campaignPublicPages)
      .where(eq(campaignPublicPages.campaignId, campaignId));

    if (!page) return null;

    // Merge the campaign-level style override into the admin response
    // so the editor can render it in the picker without a second
    // round-trip. Distinct from the donor-facing endpoint, which
    // resolves the three-layer fallback before responding.
    return { ...page, publicPageStyle: campaign.publicPageStyle ?? null };
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
    // Requires RLS context — campaigns is FORCE ROW LEVEL SECURITY.
    const [campaign] = await tx
      .select({
        id: campaigns.id,
        orgId: campaigns.orgId,
        defaultCurrency: campaigns.defaultCurrency,
      })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId));

    if (!campaign) return null;

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
    /**
     * Per-campaign archetype override (Epic #362). Tri-state:
     *   - `undefined` → leave the column untouched (the PUT only sent
     *     the public-page fields and didn't intend to clobber style).
     *   - `null` → explicitly clear the override, inherit from tenant.
     *   - one of `PUBLIC_PAGE_STYLE_KEYS` → set the override.
     *
     * The validator (`CampaignPublicPageSchema`) rejects any other
     * value before it reaches this service. The route adds the
     * `requireFlag(DONATION_PUBLIC_PAGE_STYLES)` preHandler so a
     * caller with the flag off gets 404 before the body is parsed.
     */
    publicPageStyle?: PublicPageStyleKey | null;
  },
) {
  if (!isUuid(campaignId)) {
    return null;
  }

  return withTenantContext(orgId, async (tx) => {
    const [campaign] = await tx
      .select({ id: campaigns.id })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    if (!campaign) return null;

    // Per-campaign style lives on `campaigns`, not on
    // `campaign_public_pages`, because the operator can pick a style
    // before publishing (and continue editing the draft after). Update
    // the campaign row only when the caller actually sent the field
    // — `undefined` means "leave untouched"; `null` means "clear
    // override, inherit from tenant default."
    if (body.publicPageStyle !== undefined) {
      await tx
        .update(campaigns)
        .set({
          publicPageStyle: body.publicPageStyle,
          updatedAt: new Date(),
        })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

      // Bust the public-page Redis cache so the donor view picks up
      // the new style on the next pageload (same 30 s window as colour
      // / goal / description edits — see `PUBLIC_PAGE_CACHE_TTL_SECONDS`).
      await redis.del(`${PUBLIC_PAGE_CACHE_PREFIX}${campaignId}`);
    }

    const [existing] = await tx
      .select({ id: campaignPublicPages.id })
      .from(campaignPublicPages)
      .where(eq(campaignPublicPages.campaignId, campaignId));

    let saved: typeof campaignPublicPages.$inferSelect | undefined;
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
      saved = updated;
    } else {
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
      saved = created;
    }

    // Drizzle's `.returning()` is typed as `T[]`; `[updated]` could be
    // undefined if the UPDATE matched zero rows (concurrent DELETE
    // beats this transaction). RLS already guarantees the row exists
    // under the tenant context, so this is a true should-never-happen.
    if (!saved) {
      throw new Error(`Upsert returned no row for campaign ${campaignId} — RLS / row mismatch`);
    }

    // Re-read the campaign-side style so the admin response is in
    // sync with what was just written (the caller may have explicitly
    // set it to null; the editor needs that value back to render).
    const [campaignAfter] = await tx
      .select({ publicPageStyle: campaigns.publicPageStyle })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.orgId, orgId)));

    return { ...saved, publicPageStyle: campaignAfter?.publicPageStyle ?? null };
  });
}

/**
 * Fetch the tenant's org-level default archetype (Epic #362, PR-3
 * picker UX). Routed under `/v1/tenant/style-default` so the picker
 * doesn't have to know about the broader tenant settings endpoint
 * (which exists but is a denser PATCH payload).
 *
 * Returns `null` for tenants that haven't picked a default yet —
 * the picker UI surfaces "inherits from Givernance default" in that
 * case rather than implicitly stamping `foundation` on a fresh tenant.
 */
export async function getTenantDefaultPublicPageStyle(
  orgId: string,
): Promise<PublicPageStyleKey | null> {
  return withTenantContext(orgId, async (tx) => {
    const [row] = await tx
      .select({ defaultPublicPageStyle: tenants.defaultPublicPageStyle })
      .from(tenants)
      .where(eq(tenants.id, orgId));
    const value = row?.defaultPublicPageStyle ?? null;
    // Defence-in-depth: the validator rejects unknown values on
    // write, but a soft-deleted archetype could leave a dangling
    // value. Strip anything not in the current registry so the
    // picker doesn't render a deprecated chip.
    return isPublicPageStyleKey(value) ? value : null;
  });
}

/**
 * Update the tenant's org-level default archetype (Epic #362). Same
 * tri-state contract as the campaign override: `null` clears it,
 * a key sets it, omitting the field is rejected by the validator.
 */
export async function setTenantDefaultPublicPageStyle(
  orgId: string,
  value: PublicPageStyleKey | null,
): Promise<PublicPageStyleKey | null> {
  await withTenantContext(orgId, async (tx) => {
    await tx
      .update(tenants)
      .set({ defaultPublicPageStyle: value, updatedAt: new Date() })
      .where(eq(tenants.id, orgId));
  });

  // Bust every public-page cache entry for this tenant's campaigns —
  // changing the org-level default shifts the resolved style for
  // every campaign that didn't have its own override. Scan via the
  // existing prefix; the cache is small (30 s TTL) so the SCAN cost
  // is bounded even on a tenant with hundreds of campaigns. Doing
  // this here keeps the cache contract local to the service layer
  // rather than leaking it into the route handler.
  await invalidateTenantPublicPageCache(orgId);

  return value;
}

/**
 * Best-effort cache invalidation for every cached public-page entry
 * belonging to `orgId`. Read the campaign list (RLS-scoped, indexed
 * on `org_id`), then issue a single variadic `redis.del(...keys)` —
 * ioredis pipelines it as one variadic DEL which Redis processes in
 * O(N) but in a single round-trip, so even a tenant with thousands
 * of campaigns clears in sub-10 ms on a LAN. Not transactional with
 * the DB write — a donor who lands during the ~50 ms gap sees the
 * previous style for one page-load, which is acceptable for a
 * settings change. Since PR-2's review, flag flips don't go through
 * here at all: the donor-facing flag-resolution moved out of the
 * cached payload (see `getPublicPage`), so a flag toggle is picked
 * up on the very next request regardless of cache state.
 */
async function invalidateTenantPublicPageCache(orgId: string): Promise<void> {
  const rows = await withTenantContext(orgId, async (tx) =>
    tx.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.orgId, orgId)),
  );
  if (rows.length === 0) return;
  const keys = rows.map((row) => `${PUBLIC_PAGE_CACHE_PREFIX}${row.id}`);
  await redis.del(...keys);
}
