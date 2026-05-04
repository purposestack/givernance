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

/**
 * Generate the bundled ZIP archive for a postal export (Epic #274).
 * Streams per-recipient PDFs through `archiver` into S3, ticking the
 * `campaign_postal_exports.progress_count` row so the frontend's polling
 * UI can render a real-time progress bar.
 */
export interface GeneratePostalExportJob {
  name: "generate-postal-export";
  data: {
    exportId: string;
    campaignId: string;
    orgId: string;
    mode: "door_drop" | "personalized";
  };
}

/** Process a Stripe webhook event asynchronously */
export interface ProcessStripeWebhookJob {
  name: "process-stripe-webhook";
  data: {
    webhookEventId: string;
    stripeEventId: string;
    eventType: string;
    accountId: string | null;
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
  | GeneratePostalExportJob
  | ProcessStripeWebhookJob;

/** Queue names */
export const QUEUE_NAMES = {
  RECEIPTS: "receipts",
  EMAILS: "emails",
  EXPORTS: "exports",
  GDPR: "gdpr",
  CAMPAIGNS: "campaigns",
  /**
   * Postal exports — separated from the general `campaigns` queue so a long-
   * running ZIP bundle doesn't head-of-line-block the per-PDF generation
   * jobs that share the same campaign. Both are CPU-light (PDFKit) but
   * the export holds a multipart S3 upload open for the duration of the
   * fan-out and we don't want that to delay routine sends. (Epic #274.)
   */
  POSTAL_EXPORTS: "postal_exports",
  EVENTS: "givernance_events",
  WEBHOOKS: "webhooks",
  TENANT_LIFECYCLE: "tenant_lifecycle",
} as const;

/** Repeatable job names inside TENANT_LIFECYCLE queue. */
export const TENANT_LIFECYCLE_JOBS = {
  PROVISIONAL_ADMIN_EXPIRE: "tenant.provisional-admin-expire",
} as const;
