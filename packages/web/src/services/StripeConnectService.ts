import type { ApiClient } from "@/lib/api";

export interface StripeConnectStatus {
  accountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
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
