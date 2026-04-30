/** BullMQ job type definitions */

/** Generate a tax receipt PDF for a donation */
export interface GenerateReceiptJob {
  name: "generate-receipt";
  data: {
    donationId: string;
    orgId: string;
    fiscalYear: number;
    locale: string;
  };
}

/** Send bulk email to a segment of constituents */
export interface SendBulkEmailJob {
  name: "send-bulk-email";
  data: {
    orgId: string;
    templateId: string;
    segmentFilter: Record<string, unknown>;
    scheduledAt?: string;
  };
}

/** Export data to CSV/XLSX */
export interface ExportDataJob {
  name: "export-data";
  data: {
    orgId: string;
    userId: string;
    entityType: "constituents" | "donations" | "campaigns";
    format: "csv" | "xlsx";
    filters: Record<string, unknown>;
  };
}

/** GDPR erasure — anonymize or delete constituent data */
export interface GdprErasureJob {
  name: "gdpr-erasure";
  data: {
    orgId: string;
    constituentId: string;
    requestedBy: string;
    requestedAt: string;
  };
}

/** Generate campaign document PDFs with QR codes */
export interface GenerateCampaignDocumentsJob {
  name: "generate-campaign-documents";
  data: {
    campaignId: string;
    orgId: string;
    constituentIds: string[];
  };
}

/** Process a Stripe webhook event asynchronously */
export interface ProcessStripeWebhookJob {
  name: "process-stripe-webhook";
  data: {
    webhookEventId: string;
    /**
     * Provider-native event id (kept on `stripeEventId` for backward
     * compatibility with the BullMQ payload shape). Equivalent to
     * `webhook_events.provider_event_id` post-migration 0033.
     */
    stripeEventId: string;
    eventType: string;
    accountId: string | null;
    payload: Record<string, unknown>;
  };
}

/**
 * Process a Mollie webhook event asynchronously. The Mollie webhook contract
 * sends only the affected payment id and status — the worker fetches the
 * full payment from Mollie API using the per-tenant `tenants.mollie_api_key`
 * before creating a donation row. `provider_event_id` is the synthesised
 * `${paymentId}-${status}` so retries on the same status are idempotent.
 */
export interface ProcessMollieWebhookJob {
  name: "process-mollie-webhook";
  data: {
    webhookEventId: string;
    /** Synthesised `${paymentId}-${status}` — matches `webhook_events.provider_event_id`. */
    providerEventId: string;
    /** Mollie payment id (`tr_…`) — what the worker passes to `mollie.payments.get`. */
    molliePaymentId: string;
    eventType: string;
    payload: Record<string, unknown>;
  };
}

/** Union of all job types */
export type JobDefinition =
  | GenerateReceiptJob
  | SendBulkEmailJob
  | ExportDataJob
  | GdprErasureJob
  | GenerateCampaignDocumentsJob
  | ProcessStripeWebhookJob
  | ProcessMollieWebhookJob;

/** Queue names */
export const QUEUE_NAMES = {
  RECEIPTS: "receipts",
  EMAILS: "emails",
  EXPORTS: "exports",
  GDPR: "gdpr",
  CAMPAIGNS: "campaigns",
  EVENTS: "givernance_events",
  WEBHOOKS: "webhooks",
  TENANT_LIFECYCLE: "tenant_lifecycle",
} as const;

/** Repeatable job names inside TENANT_LIFECYCLE queue. */
export const TENANT_LIFECYCLE_JOBS = {
  PROVISIONAL_ADMIN_EXPIRE: "tenant.provisional-admin-expire",
} as const;
