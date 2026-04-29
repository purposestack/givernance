import type { ApiClient } from "@/lib/api";

export type StripeCapabilityStatus = "active" | "pending" | "inactive" | "unrequested";

export interface StripeConnectStatus {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  /**
   * Stripe-emitted requirement keys (e.g. `external_account`,
   * `individual.id_number`) the operator must satisfy before
   * `chargesEnabled` flips on. Empty when fully onboarded. Drives the
   * Settings panel's remediation list (issue #201).
   */
  requirementsCurrentlyDue: string[];
  /** Stripe's reason for `chargesEnabled: false` (e.g. `requirements.past_due`). */
  disabledReason: string | null;
  capabilities: {
    cardPayments: StripeCapabilityStatus;
    transfers: StripeCapabilityStatus;
    linkPayments: StripeCapabilityStatus;
  };
}

export interface StripeOnboardingLink {
  url: string;
  accountId: string;
}

export interface StripeOnboardingInput {
  refreshUrl: string;
  returnUrl: string;
}

export const StripeConnectService = {
  async getStatus(client: ApiClient): Promise<StripeConnectStatus> {
    const response = await client.get<{ data: StripeConnectStatus }>("/v1/admin/stripe-connect");
    return response.data;
  },

  async startOnboarding(
    client: ApiClient,
    input: StripeOnboardingInput,
  ): Promise<StripeOnboardingLink> {
    const response = await client.post<{ data: StripeOnboardingLink }>(
      "/v1/admin/stripe-connect",
      input,
    );
    return response.data;
  },
};
