import type { CampaignPublicPageSchema } from "@givernance/shared/validators";
import type { Static } from "@sinclair/typebox";

import type { ApiClient } from "@/lib/api";
import { isUuid } from "@/lib/utils";
import type {
  CampaignPublicPage,
  CampaignPublicPageInput,
  CampaignPublicPageResponse,
  CheckoutConfig,
  CheckoutConfigResponse,
  PublicDonationIntent,
  PublicDonationIntentInput,
  PublishedCampaignPublicPage,
  PublishedCampaignPublicPageResponse,
} from "@/models/public-page";

type CampaignPublicPagePayload = Static<typeof CampaignPublicPageSchema>;

function requireCampaignId(campaignId: string): string {
  if (!isUuid(campaignId)) {
    throw new Error(`Invalid campaign ID: ${JSON.stringify(campaignId)}`);
  }

  return campaignId;
}

export const CampaignPublicPageService = {
  async getCampaignPublicPage(client: ApiClient, campaignId: string): Promise<CampaignPublicPage> {
    const safeCampaignId = requireCampaignId(campaignId);
    const response = await client.get<CampaignPublicPageResponse>(
      `/v1/campaigns/${encodeURIComponent(safeCampaignId)}/public-page`,
    );
    return response.data;
  },

  async getPublishedCampaignPublicPage(
    client: ApiClient,
    campaignId: string,
  ): Promise<PublishedCampaignPublicPage> {
    const safeCampaignId = requireCampaignId(campaignId);
    const response = await client.get<PublishedCampaignPublicPageResponse>(
      `/v1/public/campaigns/${encodeURIComponent(safeCampaignId)}/page`,
    );
    return response.data;
  },

  async upsertCampaignPublicPage(
    client: ApiClient,
    campaignId: string,
    input: CampaignPublicPageInput,
  ): Promise<CampaignPublicPage> {
    const safeCampaignId = requireCampaignId(campaignId);
    const response = await client.put<CampaignPublicPageResponse>(
      `/v1/campaigns/${encodeURIComponent(safeCampaignId)}/public-page`,
      toRequestBody(input),
    );
    return response.data;
  },

  /**
   * Resolve a postal QR token via the public, rate-limited endpoint
   * (Epic #274). The server stamps `scanned_at` on first contact and
   * returns `{ campaignId, constituentId }` so the caller can verify
   * the scan reached the right campaign. Returns `null` for unknown
   * tokens (the API responds 404; we swallow it because it's a
   * best-effort tracking call, not a flow-blocking step). Safe to call
   * from a server component during render — used by `/p/[id]` to log
   * the scan even if the donor never converts.
   */
  async resolvePostalQrToken(
    client: ApiClient,
    code: string,
  ): Promise<{ campaignId: string; constituentId: string | null } | null> {
    try {
      const response = await client.get<{
        data: { campaignId: string; constituentId: string | null };
      }>(`/v1/public/qr/${encodeURIComponent(code)}`);
      return response.data;
    } catch {
      return null;
    }
  },

  /**
   * Fetch checkout-config for the given campaign (Epic #416 multi-currency).
   * Called from the public page SSR component when `donation.multi_currency`
   * may be enabled; returns `null` when the flag is off (404) or the campaign
   * is not ready (422). Non-fatal — caller falls back to the hardcoded
   * `PUBLIC_DONATION_CURRENCIES` list.
   */
  async getCheckoutConfig(client: ApiClient, campaignId: string): Promise<CheckoutConfig | null> {
    const safeCampaignId = requireCampaignId(campaignId);
    try {
      const response = await client.get<CheckoutConfigResponse>(
        `/v1/campaigns/${encodeURIComponent(safeCampaignId)}/checkout-config`,
      );
      return response.data;
    } catch {
      // 404 (flag off or campaign not found) or 422 (not ready) — not fatal
      return null;
    }
  },

  async createPublicDonationIntent(
    client: ApiClient,
    campaignId: string,
    input: PublicDonationIntentInput,
    idempotencyKey?: string,
  ): Promise<PublicDonationIntent> {
    const safeCampaignId = requireCampaignId(campaignId);
    const response = await client.post<{ data: PublicDonationIntent }>(
      `/v1/public/campaigns/${encodeURIComponent(safeCampaignId)}/donate`,
      input,
      {
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
      },
    );
    return response.data;
  },
};

function toRequestBody(input: CampaignPublicPageInput): CampaignPublicPagePayload {
  const body: CampaignPublicPagePayload = {
    title: input.title,
  };

  if (input.description !== undefined) body.description = input.description;
  if (input.colorPrimary !== undefined) body.colorPrimary = input.colorPrimary;
  if (input.goalAmountCents !== undefined) body.goalAmountCents = input.goalAmountCents;
  if (input.status !== undefined) body.status = input.status;
  // Epic #362 — tri-state on `publicPageStyle`. `undefined` leaves the
  // column untouched; the caller passes `null` to explicitly clear or
  // a `PublicPageStyleKey` to set. The API gates this field with a
  // flag-aware 400 when `donation.public_page_styles` is off for the
  // tenant (PR-2 review): the editor shouldn't reach here unless the
  // SSR feature-flag check rendered the picker.
  if (input.publicPageStyle !== undefined) body.publicPageStyle = input.publicPageStyle;

  return body;
}
