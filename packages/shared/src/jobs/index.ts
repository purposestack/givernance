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
 * Generate the asynchronous ZIP archive for a campaign (Epic #274).
 *
 * Differs from {@link GenerateCampaignDocumentsJob} in that it owns the
 * end-to-end "produce a downloadable bundle" lifecycle: it fans out PDF
 * generation, bundles the output into a ZIP, uploads the archive to S3,
 * and progressively updates the `campaign_export_jobs` row so the
 * frontend can drive a progress bar without holding the request open.
 */
export interface GenerateCampaignExportJob {
  name: "generate-campaign-export";
  data: {
    exportJobId: string;
    campaignId: string;
    orgId: string;
    mode: "door_drop" | "nominative";
  };
}

/**
 * Bulk email the constituents in a free-form id list (Epic #274). Used
 * by the multi-select "Send email" action on the constituents table.
 * Distinct from {@link SendBulkEmailJob} (which targets a saved segment
 * filter) — the recipient set is a literal id array, captured at request
 * time so admin actions remain auditable.
 */
export interface SendConstituentBulkEmailJob {
  name: "send-constituent-bulk-email";
  data: {
    orgId: string;
    requestedByUserId: string;
    constituentIds: string[];
    subject: string;
    bodyText: string;
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
  | SendConstituentBulkEmailJob
  | ExportDataJob
  | GdprErasureJob
  | GenerateCampaignDocumentsJob
  | GenerateCampaignExportJob
  | ProcessStripeWebhookJob;

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
