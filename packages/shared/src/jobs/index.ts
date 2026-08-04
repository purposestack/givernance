/** BullMQ job type definitions */

import type { OutboxMetadata } from "../schema";

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
 * Generate the output artefact for a postal export (Epic #274).
 *
 * `format='zip'` streams per-recipient PDFs through `archiver` into S3;
 * `format='merged_pdf'` concatenates them into a single multi-page PDF
 * (project item #194221573). Either way the worker ticks the
 * `campaign_postal_exports.progress_count` row so the frontend's polling
 * UI can render a real-time progress bar.
 *
 * `format` is carried for logging convenience; the worker treats the
 * `campaign_postal_exports` row as the source of truth (so an operator
 * who somehow enqueued before a config change can't desync the artefact).
 */
export interface GeneratePostalExportJob {
  name: "generate-postal-export";
  data: {
    exportId: string;
    campaignId: string;
    orgId: string;
    mode: "door_drop" | "personalized";
    format: "zip" | "merged_pdf";
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
  /**
   * Nightly platform-wide sweep (issue #291, ADR-023 § Consequences):
   * removes S3 prefixes + rows for assets orphaned by a replaced logo
   * (ADR-024 — old rows "drift to nightly orphan-GC"), a failed
   * per-asset GC, or a hard-deleted tenant whose cascade beat the
   * per-asset job. Repeatable cron, no payload — not outbox-routed.
   */
  ORPHAN_GC_SWEEP: "branding.orphan_gc_sweep",
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

/**
 * Nightly orphan-GC sweep over the branding bucket (issue #291).
 * Repeatable job — the payload is empty; every sweep re-derives its
 * work list from `org_branding_assets` + the bucket's top-level
 * prefixes at run time.
 */
export interface BrandingOrphanGcSweepJob {
  name: "branding.orphan_gc_sweep";
  data: Record<string, never>;
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
    /**
     * W3C trace-context built by the API route (issue #575). Rides in the
     * job payload because this flow enqueues BullMQ directly (F3
     * constant-time 204) instead of going through the outbox; the worker
     * re-validates it (`sanitiseJobMetadata`) before stamping it onto the
     * `tenant.signup_verification_resent` outbox insert. Absent on jobs
     * enqueued by pre-#575 builds.
     */
    metadata?: OutboxMetadata | null;
  };
}

/**
 * The signup-resend payload as consumed by the worker processor and
 * produced by the API's `enqueueSignupResend` — a single named alias so
 * the two packages cannot drift shape without a type error.
 */
export type SignupResendJobPayload = SignupResendJob["data"];

/**
 * Generate the monthly platform finance report PDF (issue #443).
 *
 * `reportId` is the `platform_finance_reports.id` row the API created
 * before enqueuing this job. The worker re-reads the row, runs
 * `buildFinanceSummary` for the target month, renders the PDF,
 * uploads to `S3_REPORTS_BUCKET`, then flips the row to
 * `status='ready'` with `pdf_s3_key` set. No PII flows through Redis
 * — only the row id + the month label (for log readability).
 */
export interface GenerateMonthlyFinanceReportJob {
  name: "generate-monthly-finance-report";
  data: {
    reportId: string;
    /** YYYY-MM target month — denormalised from the row for log readability. */
    month: string;
    traceparent?: string;
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

// ─── Custom fields (Epic #539) ──────────────────────────────────────────────

/**
 * Outbox event types emitted by the customization module. The API's
 * option-merge route writes the row inside the same transaction as the
 * merge bookkeeping; the relay hands it to `routeDomainEvent`, which
 * enqueues the backfill onto `CUSTOM_FIELDS_QUEUE` (queue + job names
 * live in `custom-fields/constants.ts` so the web package can import
 * that directory without pulling these backend job types).
 */
export const CUSTOM_FIELD_EVENT_TYPES = {
  /**
   * A picklist option merge was requested. Payload contract (ids only,
   * no PII): `{ mergeId, definitionId, sourceOptionId, targetOptionId,
   * requestedBy? }` — `requestedBy` is the Keycloak `sub` of the
   * requesting admin (same identifier every other `audit_logs.user_id`
   * carries) so the worker can attribute the backfill audit row.
   */
  OPTION_MERGE_REQUESTED: "custom_field.option_merge_requested",
  /**
   * A previously executed option merge is being reverted (30-day undo
   * window). Same payload contract as the merge event; the worker
   * restores `previous_value` from `custom_field_merge_undo` rows.
   */
  OPTION_MERGE_UNDO_REQUESTED: "custom_field.option_merge_undo_requested",
} as const;

/**
 * Option-merge backfill input (Epic #539). Rewrites stored values of
 * the merged option id to the survivor across the definition's domain
 * table, chunk by chunk, writing `custom_field_merge_undo` rows in the
 * same transaction as each chunk's rewrite (idempotent: rewritten rows
 * stop matching the containment predicate, so a retry resumes cleanly
 * and never duplicates undo rows).
 */
export interface CustomFieldOptionMergeJob {
  name: "custom-field-option-merge-backfill";
  data: {
    orgId: string;
    /** Groups the undo rows of one merge — the undo unit. */
    mergeId: string;
    definitionId: string;
    sourceOptionId: string;
    targetOptionId: string;
    /** Keycloak `sub` of the requesting admin (audit attribution). */
    requestedBy?: string | null;
    traceparent?: string;
  };
}

/**
 * Option-merge undo input (Epic #539). Restores the pre-merge value of
 * each `custom_field_merge_undo` row of one merge and deletes the undo
 * row in the same transaction — a crashed/retried job resumes exactly
 * where it left off and never double-restores.
 */
export interface CustomFieldOptionMergeUndoJob {
  name: "custom-field-option-merge-undo-backfill";
  data: {
    orgId: string;
    mergeId: string;
    definitionId: string;
    sourceOptionId: string;
    targetOptionId: string;
    /** Keycloak `sub` of the requesting admin (audit attribution). */
    requestedBy?: string | null;
    traceparent?: string;
  };
}

/**
 * Re-wrap receipt DEKs under the active KEK version (issue #228).
 *
 * Manual, runbook-triggered rotation sweep on the RECEIPTS queue (see
 * `RECEIPT_JOBS.REWRAP_DEKS`): after the operator adds a new KEK
 * version (new keyring entry / new Scaleway key) and flips the active
 * version, this job walks every encrypted `receipts` row still wrapped
 * under an older version, unwraps with the old KEK and re-wraps with
 * the active one. DB-only — the S3 ciphertext (encrypted with the
 * per-receipt DEK, which never changes) is untouched; that is the
 * whole point of the envelope design. Enqueue via
 * `packages/worker/scripts/trigger-rewrap-receipt-deks.ts`.
 */
export interface RewrapReceiptDeksJob {
  name: "receipts.rewrap_deks";
  data: {
    /** Operator identity for the audit trail (runbook fills it in). */
    requestedBy?: string;
    /**
     * Bypass the `donation.receipt_envelope_encryption` flag gate —
     * EMERGENCY rotation only. Encrypted rows outlive the flag (turning
     * it off only stops encrypting NEW receipts), so a compromised-KEK
     * response must be able to rotate without first re-enabling
     * encryption platform-wide. The processor logs loudly when used.
     */
    force?: boolean;
    traceparent?: string;
  };
}

/**
 * Job names inside the RECEIPTS queue. GENERATE predates this const
 * (the literal "generate-receipt" is enqueued by the events router);
 * REWRAP_DEKS is the manual KEK-rotation sweep (issue #228).
 */
export const RECEIPT_JOBS = {
  GENERATE: "generate-receipt",
  REWRAP_DEKS: "receipts.rewrap_deks",
} as const;

/** Union of all job types */
export type JobDefinition =
  | GenerateReceiptJob
  | RewrapReceiptDeksJob
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
  | ProcessBulkImportJob
  | CustomFieldOptionMergeJob
  | CustomFieldOptionMergeUndoJob
  | GenerateMonthlyFinanceReportJob;

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
  /**
   * Super-admin monthly finance report PDF generation (issue #443).
   * One job per `platform_finance_reports` row. Concurrency 1 per
   * worker process — each job runs the full `buildFinanceSummary`
   * aggregation (~12 SQL queries through `systemDb`) + a PDFKit
   * render + a multipart S3 upload; running two side-by-side would
   * pin both the Postgres pool and the event loop. Scale by adding
   * worker pods, not concurrency.
   */
  PLATFORM_REPORTS: "platform_reports",
} as const;

/** Job names inside the NOTIFICATIONS_DIGEST queue. */
export const NOTIFICATIONS_DIGEST_JOBS = {
  DAILY: "notifications.digest_daily",
} as const;

/**
 * Job names inside the PLATFORM_REPORTS queue.
 *
 *  - MONTHLY_AUTO_TRIGGER — cron-fired on the 1st of each month at
 *    03:30 UTC, and once at worker startup for the boot-time backfill.
 *    The processor resolves the previous calendar month, idempotently
 *    inserts a pending row (with kpi_snapshot), and enqueues GENERATE_PDF.
 *  - GENERATE_PDF — one job per `platform_finance_reports` row;
 *    renders the PDF from the pre-built kpi_snapshot and uploads to S3.
 */
export const PLATFORM_REPORTS_JOBS = {
  MONTHLY_AUTO_TRIGGER: "platform_reports.monthly_auto_trigger",
  GENERATE_PDF: "generate-monthly-finance-report",
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
