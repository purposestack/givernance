import type { ApiClient } from "@/lib/api";
import type { PaymentGatewayKey } from "@/models/public-page";

export interface PaymentGatewaySettings {
  paymentGateway: PaymentGatewayKey;
  /** True when the tenant has a stored Mollie API key (the value itself never leaves the API). */
  mollieConfigured: boolean;
  flags: {
    "ff.payments.mollie": boolean;
  };
}

export interface PaymentGatewayUpdate {
  paymentGateway: PaymentGatewayKey;
  /**
   * Mollie API key. Send a non-empty string to set / rotate, `null` or `""`
   * to clear, or omit to keep the existing value untouched. Required when
   * switching `paymentGateway` to `'mollie'` for the first time.
   */
  mollieApiKey?: string | null;
}

export const PaymentGatewayService = {
  async getSettings(client: ApiClient): Promise<PaymentGatewaySettings> {
    const response = await client.get<{ data: PaymentGatewaySettings }>(
      "/v1/admin/payment-gateway",
    );
    return response.data;
  },
  async updateSettings(
    client: ApiClient,
    input: PaymentGatewayUpdate,
  ): Promise<PaymentGatewaySettings> {
    const response = await client.patch<{ data: PaymentGatewaySettings }>(
      "/v1/admin/payment-gateway",
      input,
    );
    return response.data;
  },
};
