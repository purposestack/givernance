import type { CampaignPublicPageColor } from "@givernance/shared/validators";

export type PublicPageStatus = "draft" | "published";
export type PublicDonationCurrency = "EUR" | "GBP" | "CHF";
/** Mirrors `tenants.payment_gateway` enum (issue #62). Drives donor-frontend branching. */
export type PaymentGatewayKey = "stripe" | "mollie" | "manual";

export interface CampaignPublicPage {
  id: string;
  orgId: string;
  campaignId: string;
  status: PublicPageStatus;
  title: string;
  description: string | null;
  colorPrimary: CampaignPublicPageColor | null;
  goalAmountCents: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignPublicPageResponse {
  data: CampaignPublicPage;
}

export interface PublishedCampaignPublicPage {
  id: string;
  campaignId: string;
  title: string;
  description: string | null;
  colorPrimary: CampaignPublicPageColor | null;
  goalAmountCents: number | null;
  defaultCurrency: PublicDonationCurrency;
  /** Tenant's selected gateway (issue #62) — drives donor-frontend branching. */
  paymentGateway: PaymentGatewayKey;
  /** `acct_…` for the campaign's tenant; null when not yet onboarded or non-Stripe gateway. */
  stripeAccountId: string | null;
  /** Cumulative cleared donations in the tenant's base currency (issue #200). */
  raisedCents: number;
  /** Distinct donor count, cleared donations only (issue #200). */
  donorCount: number;
}

export interface PublishedCampaignPublicPageResponse {
  data: PublishedCampaignPublicPage;
}

export interface CampaignPublicPageInput {
  title: string;
  description?: string | null;
  colorPrimary?: CampaignPublicPageColor | null;
  goalAmountCents?: number | null;
  status?: PublicPageStatus;
}

export interface PublicDonationIntentInput {
  amountCents: number;
  currency: PublicDonationCurrency;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Discriminated union returned by `POST /v1/public/campaigns/:id/donate`
 * (issue #62). The donor frontend renders Stripe Elements when
 * `provider === 'stripe'` or redirects to Mollie's checkout URL when
 * `provider === 'mollie'`.
 */
export type PublicDonationIntent =
  | {
      provider: "stripe";
      clientSecret: string;
      /** Connected account the PaymentIntent lives on; needed by `loadStripe(pk, { stripeAccount })`. */
      stripeAccountId: string;
    }
  | {
      provider: "mollie";
      /** Mollie-hosted checkout URL — the browser navigates here. */
      checkoutUrl: string;
      molliePaymentId: string;
    };

export interface PublicDonationIntentResponse {
  data: PublicDonationIntent;
}
