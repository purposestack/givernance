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

/**
 * Send bulk email to a tracked job's recipient snapshot (issue #326).
 *
 * `bulkEmailJobId` is the FK into `bulk_email_jobs`. The worker reads
 * subject, body, and constituent_ids from that row at job start —
 * minimises what flows through Redis (no PII, no large payload) and
 * lets a resume job consume the freshest `delivered_constituent_ids`
 * snapshot when it computes "remaining".
 *
 * `templateId` and `segmentFilter` are retained as optional fields for
 * the future template-engine / saved-segment paths (out of scope for
 * #326; the current MVP path passes only `bulkEmailJobId`).
 */
export interface SendBulkEmailJob {
  name: "send-bulk-email";
  data: {
    orgId: string;
    bulkEmailJobId: string;
    templateId?: string;
    segmentFilter?: Record<string, unknown>;
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

// ─── Org branding (Epic #286) ────────────────────────────────────────────────

/**
 * Outbox event types emitted by the branding upload flow. These are
 * the `outbox_events.type` strings the API writes; the relay enqueues
 * matching BullMQ jobs for the worker processors below.
 */
export const BRANDING_EVENT_TYPES = {
  /** Run the variant pipeline against a freshly-uploaded asset row. */
  PROCESS_ASSET: "branding.process_asset",
  /** Flip `tenants.logo_asset_id` once the asset is `status='ready'`. */
  ACTIVATE_LOGO: "branding.activate_logo",
  /** GC S3 prefix + clear KC org attribute for a soft-deleted asset. */
  GC_ASSET: "branding.gc_asset",
  /** Sync `tenants.logo_asset_id` → KC org `logo_url` attribute. */
  KEYCLOAK_SYNC_ORG_LOGO: "keycloak.sync_org_logo",
} as const;

/** Process a freshly-uploaded branding asset (derive variants, flip status). */
export interface BrandingProcessAssetJob {
  name: "branding.process_asset";
  data: {
    assetId: string;
    orgId: string;
  };
}

/** Activate a `ready` asset by pointing `tenants.logo_asset_id` at it. */
export interface BrandingActivateLogoJob {
  name: "branding.activate_logo";
  data: {
    assetId: string;
    orgId: string;
  };
}

/** Garbage-collect a soft-deleted asset (S3 prefix + KC attribute clear). */
export interface BrandingGcAssetJob {
  name: "branding.gc_asset";
  data: {
    assetId: string;
    orgId: string;
    /** S3 prefix to delete (`{org}/logo/{asset}/`). */
    prefix: string;
  };
}

/** Sync the active logo URL (or empty) into the KC organization attributes. */
export interface KeycloakSyncOrgLogoJob {
  name: "keycloak.sync_org_logo";
  data: {
    orgId: string;
  };
}

/**
 * Defer the signup-resend lookup-and-rotate work onto BullMQ so the public
 * resend endpoint takes constant HTTP time whether or not the email matches
 * a pending/half-provisioned tenant (F3 — close the timing-side-channel that
 * defeats the resend route's anti-enumeration property).
 */
export interface SignupResendJob {
  name: "tenant.signup-resend";
  data: {
    /** Email submitted to `POST /v1/public/signup/resend` (lowercased / trimmed). */
    email: string;
  };
}

// ─── Super-admin finance dashboard (Epic #434, issue #436) ──────────────────

/**
 * Cron-scheduled job names inside the FINANCE_DASHBOARD queue. Powers the
 * enrichment that backs the super-admin "Finance plateforme" dashboard:
 *
 *  - CONSTITUENT_COUNT_REFRESH (daily, 03:00 UTC) — refreshes
 *    `tenants.constituent_count_cached` so the per-tenant tile doesn't
 *    re-COUNT(constituents) on every page render.
 *  - SURVEY_SEND (hourly) — picks up `surveys WHERE next_scheduled_at
 *    <= NOW()`, fans out invitations to the cohort, enqueues email
 *    sends, and re-schedules cyclical surveys.
 *  - SURVEY_RETENTION (weekly, Sunday 04:00 UTC) — soft-deletes
 *    `survey_responses` older than 24 months (docs/31).
 *
 * All three respect the `admin.finance_dashboard` feature flag — a
 * no-op (early return) when the flag is off so a paused rollout
 * doesn't churn Postgres for nothing.
 */
export const FINANCE_DASHBOARD_JOBS = {
  CONSTITUENT_COUNT_REFRESH: "finance.constituent_count_refresh",
  SURVEY_SEND: "finance.survey_send",
  SURVEY_RETENTION: "finance.survey_retention",
} as const;

/**
 * Outbox event types emitted by the survey send loop (issue #436). The
 * API agent (#437) wires the email-send consumer for these; the worker
 * inserts a row into `outbox_events` and lets the transactional outbox
 * relay enqueue the actual email send via existing infra.
 */
export const SURVEY_EVENT_TYPES = {
  /** A survey invitation needs an email send (channel='email'). */
  INVITATION_SEND_EMAIL: "survey.invitation.send_email",
} as const;

/**
 * Outbox event types emitted by the user lifecycle (issue #439). The
 * producer is the `DELETE /v1/users/:id` route handler, which emits
 * inside the same transaction as the soft-delete itself so a relay
 * redelivery and a tx rollback can never disagree about whether the
 * downstream cascade is owed.
 *
 * Consumers — fanout-style, NOT routed through `routeDomainEvent`
 * (these events drive side-effects in MULTIPLE subsystems, the same
 * pattern as the notifications fanout):
 *  - `survey-erasure-cascade` (this issue) — NULLs every pending
 *    `survey_invitations.user_id` for the soft-deleted user and emits
 *    one `audit_logs` row per affected invitation.
 *  - Future subsystems that need to react to a tenant user erasure.
 */
export const USER_EVENT_TYPES = {
  /** A tenant user row has just been soft-deleted (deleted_at = NOW(), keycloak_id = NULL). */
  SOFT_DELETED: "user.soft_deleted",
} as const;

/**
 * Bulk-import processor input (Epic #373).
 *
 * Outbox payload only carries the `bulkImportJobId`. The worker re-reads
 * the `bulk_import_jobs` row + downloads the uploaded file from S3 under
 * its own RLS context; PII never lives in Redis nor in the BullMQ job
 * payload.
 */
export interface ProcessBulkImportJob {
  name: "process-bulk-import";
  data: {
    orgId: string;
    bulkImportJobId: string;
    traceparent?: string;
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
  | ProcessStripeWebhookJob
  | BrandingProcessAssetJob
  | BrandingActivateLogoJob
  | BrandingGcAssetJob
  | KeycloakSyncOrgLogoJob
  | SignupResendJob
  | ProcessBulkImportJob;

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
  /**
   * Branding asset processing — one queue for the variant pipeline +
   * activation + GC. Concurrency-1 per worker process: each job holds
   * a sharp pipeline open against libvips and uploads four variants
   * via separate S3 calls. Scale by adding pods, not concurrency.
   */
  BRANDING: "branding",
  /** Keycloak org-attribute syncs (logo_url, theme_primary_color, …). */
  KEYCLOAK_SYNC: "keycloak_sync",
  /**
   * Notification email digest (Epic #363, GLO-004 — Phase 5). One
   * recurring job at 09:00 UTC daily; the processor iterates every
   * tenant with an opted-in user and sends one batched email per
   * recipient. Concurrency-1 — opt-in distribution is small enough
   * not to need parallelism, and we'd rather not flood the SMTP
   * relay if a large tenant joins.
   */
  NOTIFICATIONS_DIGEST: "notifications_digest",
  /**
   * Bulk-import constituents (Epic #373). One job per upload; the worker
   * downloads the file from S3, parses CSV/XLSX, and inserts constituents
   * in batches of 50 under the worker's RLS context. Concurrency 1 per
   * worker process — the parser holds a buffer + the duplicate-detection
   * trigram query is CPU-bound; scale by adding pods.
   */
  BULK_IMPORT: "bulk_import",
  /**
   * Super-admin finance dashboard enrichment (Epic #434, issue #436).
   * Carries three cron-scheduled job names — constituent-count refresh,
   * survey send loop, survey retention sweep. Concurrency 1 per worker
   * process; all three are platform-wide sweeps that should not run
   * concurrently with themselves (constituent count UPDATEs against
   * every tenant in turn; survey send claims invitations idempotently).
   */
  FINANCE_DASHBOARD: "finance_dashboard",
} as const;

/** Job names inside the NOTIFICATIONS_DIGEST queue. */
export const NOTIFICATIONS_DIGEST_JOBS = {
  DAILY: "notifications.digest_daily",
} as const;

/** Repeatable job names inside TENANT_LIFECYCLE queue. */
export const TENANT_LIFECYCLE_JOBS = {
  PROVISIONAL_ADMIN_EXPIRE: "tenant.provisional-admin-expire",
  /**
   * F3 — Defer the public resend endpoint's lookup-and-rotate work onto the
   * worker so the HTTP response is constant-time across the
   * "matches a pending tenant" and "no match" branches.
   */
  SIGNUP_RESEND: "tenant.signup-resend",
} as const;
