/**
 * Checkout-config route — public endpoint that resolves the settlement
 * currency and supported presentment currencies for a campaign.
 *
 * This is intentionally PUBLIC (no auth required) — it is called from the
 * donor-facing public donation page before the donor logs in. The response
 * must never expose fund names, bank account IDs, IBANs, split percentages,
 * or any other fund internals.
 *
 * Resolution flow (ADR-032 §2.6, Epic #416 Task 15):
 *
 *   campaign_funds WHERE is_online_default = TRUE
 *     → funds.bank_account_id → bank_accounts.currency  (= settlement_currency)
 *     → Redis GET stripe:currencies:{settlement_currency}
 *         HIT  → return cached list (already filtered by currency_metadata.enabled)
 *         MISS → populate from hardcoded map, filter by currency_metadata.enabled,
 *                cache TTL 86 400 s, return
 *
 * Feature flag: DONATION_MULTI_CURRENCY MUST be the FIRST preHandler — before
 * any auth guard — so scanners get 404 without enumerating role requirements.
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import {
  bankAccounts,
  campaignFunds,
  campaigns,
  currencyMetadata,
  funds,
} from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { systemDb } from "../../lib/db.js";
import { requireFlag } from "../../lib/flags/flag-guard.js";
import { redis } from "../../lib/redis.js";
import { DataResponse, ErrorResponses, IdParams, problemDetail } from "../../lib/schemas.js";

/** Redis TTL for the presentment-currency list (24 hours). */
const STRIPE_CACHE_TTL_SECONDS = 86400;

/**
 * Hardcoded map of settlement currency → candidate presentment currencies.
 *
 * Source: Stripe's multi-currency settlement documentation combined with the
 * currencies supported across our primary EU/UK/CH markets. This list is
 * further filtered at runtime by `currency_metadata.enabled` so a platform
 * admin can disable a currency without a code deploy.
 *
 * Order within each array is intentional: the settlement currency leads,
 * followed by the most-common cross-border choices.
 */
const STRIPE_PRESENTMENT_BY_SETTLEMENT: Record<string, string[]> = {
  EUR: ["EUR", "USD", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "JPY"],
  CHF: ["CHF", "EUR", "USD", "GBP"],
  GBP: ["GBP", "EUR", "USD", "CHF", "SEK", "NOK", "DKK"],
  USD: ["USD", "EUR", "GBP", "CHF", "JPY"],
  SEK: ["SEK", "EUR", "USD", "GBP", "NOK", "DKK"],
  NOK: ["NOK", "EUR", "USD", "GBP", "SEK", "DKK"],
  DKK: ["DKK", "EUR", "USD", "GBP", "SEK", "NOK"],
  PLN: ["PLN", "EUR", "USD", "GBP"],
  CZK: ["CZK", "EUR", "USD", "GBP"],
};

const CheckoutConfigResponseSchema = Type.Object({
  settlementCurrency: Type.String(),
  presentmentCurrencies: Type.Array(Type.String()),
});

export async function checkoutConfigRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/campaigns/:id/checkout-config",
    {
      schema: {
        params: IdParams,
        response: {
          200: DataResponse(CheckoutConfigResponseSchema),
          ...ErrorResponses,
        },
      },
      preHandler: [requireFlag(FEATURE_FLAG_KEYS.DONATION_MULTI_CURRENCY)],
    },
    async (request, reply) => {
      const { id } = request.params;

      // systemDb: public endpoint — no authenticated tenant context, so RLS would
      // block all reads via the app pool. Lookups are by PK (campaignId) with no
      // cross-tenant data exposure (campaign IDs are unguessable UUIDs).
      const [campaign] = await systemDb
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(eq(campaigns.id, id))
        .limit(1);

      if (!campaign) {
        return reply.code(404).send(problemDetail(404, "campaign_not_found", "Campaign not found"));
      }

      // 2. Resolve the online-default fund routing entry for this campaign.
      const [routing] = await systemDb
        .select({ fundId: campaignFunds.fundId })
        .from(campaignFunds)
        .where(and(eq(campaignFunds.campaignId, id), eq(campaignFunds.isOnlineDefault, true)))
        .limit(1);

      if (!routing) {
        return reply
          .code(422)
          .send(
            problemDetail(
              422,
              "campaign_not_ready_for_online_payment",
              "Campaign has no online-default fund configured",
            ),
          );
      }

      // 3. Resolve the bank account linked to the fund (settlement currency source).
      const [fund] = await systemDb
        .select({ bankAccountId: funds.bankAccountId })
        .from(funds)
        .where(eq(funds.id, routing.fundId))
        .limit(1);

      if (!fund?.bankAccountId) {
        return reply
          .code(422)
          .send(
            problemDetail(
              422,
              "campaign_not_ready_for_online_payment",
              "Fund has no linked bank account",
            ),
          );
      }

      // 4. Read the settlement currency from the bank account.
      const [bankAccount] = await systemDb
        .select({ currency: bankAccounts.currency })
        .from(bankAccounts)
        .where(eq(bankAccounts.id, fund.bankAccountId))
        .limit(1);

      if (!bankAccount) {
        return reply
          .code(422)
          .send(
            problemDetail(
              422,
              "campaign_not_ready_for_online_payment",
              "Fund bank account not found",
            ),
          );
      }

      const settlementCurrency = bankAccount.currency;
      const cacheKey = `stripe:currencies:${settlementCurrency}`;

      // 5. Try the Redis cache first (populated with pre-filtered list).
      const cached = await redis.get(cacheKey);
      if (cached) {
        const presentmentCurrencies = JSON.parse(cached) as string[];
        return reply.send({ data: { settlementCurrency, presentmentCurrencies } });
      }

      // 6. Cache miss — build from the hardcoded map filtered by enabled currencies.
      const candidateCurrencies = STRIPE_PRESENTMENT_BY_SETTLEMENT[settlementCurrency] ?? [
        settlementCurrency,
      ];

      const enabledRows = await systemDb
        .select({ code: currencyMetadata.code })
        .from(currencyMetadata)
        .where(
          and(
            inArray(currencyMetadata.code, candidateCurrencies),
            eq(currencyMetadata.enabled, true),
          ),
        );

      const enabledSet = new Set(enabledRows.map((r) => r.code));
      const presentmentCurrencies = candidateCurrencies.filter((c) => enabledSet.has(c));

      // Populate the cache so the next request (and all replicas) skip the DB.
      await redis.set(
        cacheKey,
        JSON.stringify(presentmentCurrencies),
        "EX",
        STRIPE_CACHE_TTL_SECONDS,
      );

      return reply.send({ data: { settlementCurrency, presentmentCurrencies } });
    },
  );
}
