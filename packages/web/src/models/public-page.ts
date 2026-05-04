import type { CampaignPublicPageColor } from "@givernance/shared/validators";

export type PublicPageStatus = "draft" | "published";
export type PublicDonationCurrency = "EUR" | "GBP" | "CHF";

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
  /** `acct_…` for the campaign's tenant; null when not yet onboarded. */
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
  /**
   * Opaque QR token from a postal letter (Epic #274). When present, the
   * API resolves the token server-side and stamps `qr_code_id` /
   * `qr_code_constituent_id` on the resulting Stripe metadata so the
   * webhook can attribute the donation back to the QR scan.
   */
  qrCode?: string;
}

export interface PublicDonationIntent {
  clientSecret: string;
  /**
   * Connected account the PaymentIntent lives on. Stripe.js needs this when
   * confirming a direct-charge intent — `loadStripe(pk, { stripeAccount })`.
   */
  stripeAccountId: string;
}

export interface PublicDonationIntentResponse {
  data: PublicDonationIntent;
}
