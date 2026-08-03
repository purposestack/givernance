/** BullMQ Worker entry point — registers all job processors */

import { CUSTOM_FIELD_JOBS, CUSTOM_FIELDS_QUEUE } from "@givernance/shared/custom-fields";
import {
  BRANDING_EVENT_TYPES,
  FINANCE_DASHBOARD_JOBS,
  NOTIFICATIONS_DIGEST_JOBS,
  PLATFORM_REPORTS_JOBS,
  QUEUE_NAMES,
  RECEIPT_JOBS,
  TENANT_LIFECYCLE_JOBS,
} from "@givernance/shared/jobs";
import type { Job } from "bullmq";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "./env.js";
import { assertWorkerAppRoleSecure } from "./lib/db.js";
import { jobLogger, logger } from "./lib/logger.js";
import { routeDomainEvent } from "./lib/route-domain-event.js";
import { extractTraceId } from "./lib/trace-context.js";
import { processBrandingActivateLogo } from "./processors/branding-activate-logo.js";
import { processBrandingGcAsset } from "./processors/branding-gc-asset.js";
import { processBrandingOrphanGcSweep } from "./processors/branding-orphan-gc-sweep.js";
import { processBrandingAsset } from "./processors/branding-process-asset.js";
import { processGenerateCampaignDocuments } from "./processors/campaign-documents.js";
import { processCustomFieldOptionMerge } from "./processors/custom-field-option-merge.js";
import { processCustomFieldOptionMergeUndo } from "./processors/custom-field-option-merge-undo.js";
import { processCustomFieldUndoPurge } from "./processors/custom-field-undo-purge.js";
import { processConstituentCountRefresh } from "./processors/finance-constituent-count-refresh.js";
import { processSurveyRetention } from "./processors/finance-survey-retention.js";
import { processSurveySend } from "./processors/finance-survey-send.js";
import { processGdprErasure } from "./processors/gdpr-erasure.js";
import { processGenerateMonthlyFinanceReport } from "./processors/generate-monthly-finance-report.js";
import { processGenerateReceipt } from "./processors/generate-receipt.js";
import { processKeycloakSyncOrgLogo } from "./processors/keycloak-sync-org-logo.js";
import { processNotificationsEmailDigest } from "./processors/notifications-email-digest.js";
import { fanoutNotifications } from "./processors/notifications-fanout.js";
import { processPlatformAdminInviteEmail } from "./processors/platform-admin-invite-email.js";
import {
  type PlatformReportTriggerPayload,
  processPlatformReportAutoTrigger,
} from "./processors/platform-report-trigger.js";
import { processGeneratePostalExport } from "./processors/postal-export.js";
import { processBulkImport } from "./processors/process-bulk-import.js";
import { processRewrapReceiptDeks } from "./processors/rewrap-receipt-deks.js";
import { processSendBulkEmail } from "./processors/send-bulk-email.js";
import { processSignupVerificationEmail } from "./processors/signup-email.js";
import { processSignupResend } from "./processors/signup-resend.js";
import { processStripeWebhook } from "./processors/stripe-webhook.js";
import { fanoutSurveyErasure } from "./processors/survey-erasure-cascade.js";
import { processSurveyInvitationEmail } from "./processors/survey-invitation-email.js";
import { processTeamInviteEmail } from "./processors/team-invite-email.js";
import { processTenantLifecycle } from "./processors/tenant-lifecycle.js";

/** Create a fresh ioredis connection — BullMQ requires separate connections for Queue vs Worker */
function createRedisConnection() {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

/** Queue handles use their own Redis connection (separate from workers) */
const queueConnection = createRedisConnection();
const receiptsQueue = new Queue(QUEUE_NAMES.RECEIPTS, { connection: queueConnection });
const campaignsQueue = new Queue(QUEUE_NAMES.CAMPAIGNS, { connection: queueConnection });
const postalExportsQueue = new Queue(QUEUE_NAMES.POSTAL_EXPORTS, { connection: queueConnection });
const emailsQueue = new Queue(QUEUE_NAMES.EMAILS, { connection: queueConnection });
const tenantLifecycleQueue = new Queue(QUEUE_NAMES.TENANT_LIFECYCLE, {
  connection: queueConnection,
});
const brandingQueue = new Queue(QUEUE_NAMES.BRANDING, { connection: queueConnection });
const keycloakSyncQueue = new Queue(QUEUE_NAMES.KEYCLOAK_SYNC, { connection: queueConnection });
const notificationsDigestQueue = new Queue(QUEUE_NAMES.NOTIFICATIONS_DIGEST, {
  connection: queueConnection,
  // BullMQ Worker constructors don't honour `attempts/backoff` — those
  // settings live on `Queue` `defaultJobOptions` (and per-`add()`
  // overrides). Wiring them here so a transient SMTP / PG flake at
  // 09:00 UTC retries with exponential backoff instead of silently
  // losing the entire day's digest. Also bounds completed/failed job
  // retention so the BullMQ keyspace doesn't grow indefinitely.
  // (PR #393 Worker SRE HIGH-3 / MED for repeatable GC.)
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  },
});
const bulkImportQueue = new Queue(QUEUE_NAMES.BULK_IMPORT, { connection: queueConnection });

// Epic #539 — custom-field background work: option-merge backfills
// (routed from the outbox) + the daily merge-undo purge cron. Carries a
// repeatable job, so retry policy must live on the Queue's
// defaultJobOptions (Worker-level attempts/backoff are ignored — see
// the notifications-digest comment above).
const customFieldsQueue = new Queue(CUSTOM_FIELDS_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  },
});

// #436 — Super-admin finance dashboard enrichment queue. Carries three
// cron-scheduled job names (constituent-count refresh, survey send,
// survey retention). Default retry policy mirrors the digest queue —
// transient PG flakes get exponential backoff, but the cron tick
// retries cleanly on the next interval if all attempts fail.
const financeDashboardQueue = new Queue(QUEUE_NAMES.FINANCE_DASHBOARD, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  },
});

// #443 — Monthly platform finance report auto-trigger queue. Carries
// two job names: MONTHLY_AUTO_TRIGGER (cron + boot backfill) and
// GENERATE_PDF (one job per platform_finance_reports row). Retry policy
// mirrors the finance-dashboard queue — exponential backoff on transient
// PG / S3 flakes; cron retries at the next monthly tick if all attempts
// exhaust.
const platformReportsQueue = new Queue(QUEUE_NAMES.PLATFORM_REPORTS, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  },
});

/**
 * Register the nightly provisional-admin expire job.
 *
 * Runs at 03:15 UTC daily — after the busy EU evening window, before the
 * morning support shift. `jobId` is fixed so re-registering across worker
 * restarts doesn't fan-out to duplicate repeatable schedules.
 */
async function scheduleRepeatableJobs() {
  // Issue #291 / ADR-023 — nightly branding orphan-GC sweep at 02:00
  // UTC (before the 03:xx cron cluster; the sweep lists the whole
  // bucket so it gets the quietest slot). Fixed `jobId` so worker
  // restarts don't fan out duplicate schedules. Retry opts are set
  // per-add because `brandingQueue` deliberately carries no
  // `defaultJobOptions` — the outbox-routed branding jobs manage their
  // own retry posture and must not be changed by this cron.
  await brandingQueue.add(
    BRANDING_EVENT_TYPES.ORPHAN_GC_SWEEP,
    {},
    {
      jobId: "branding-orphan-gc-sweep-nightly",
      repeat: { pattern: "0 2 * * *", tz: "UTC" },
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  await tenantLifecycleQueue.add(
    TENANT_LIFECYCLE_JOBS.PROVISIONAL_ADMIN_EXPIRE,
    {},
    {
      jobId: "tenant-provisional-admin-expire-daily",
      repeat: { pattern: "15 3 * * *", tz: "UTC" },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  // Notifications email digest (Epic #363, Phase 5). Daily at 09:00
  // UTC — early enough to be the operator's morning catch-up email,
  // late enough to capture an overnight donation burst. `jobId` is
  // fixed so re-registering across worker restarts doesn't fan out
  // to duplicate repeatable schedules.
  await notificationsDigestQueue.add(
    NOTIFICATIONS_DIGEST_JOBS.DAILY,
    {},
    {
      jobId: "notifications-digest-daily",
      repeat: { pattern: "0 9 * * *", tz: "UTC" },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  // #436 — Super-admin finance dashboard enrichment crons. All three are
  // platform-wide sweeps. `jobId` is fixed per schedule so worker
  // restarts don't fan out duplicates.

  // Daily constituent-count refresh at 03:00 UTC — pre-EU morning so
  // the dashboard's per-tenant tile is fresh by the time super-admins
  // log in.
  await financeDashboardQueue.add(
    FINANCE_DASHBOARD_JOBS.CONSTITUENT_COUNT_REFRESH,
    {},
    {
      jobId: "finance-constituent-count-refresh-daily",
      repeat: { pattern: "0 3 * * *", tz: "UTC" },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  // Hourly survey-send sweep — picks up any survey whose
  // next_scheduled_at has elapsed. Hourly granularity (rather than
  // daily) is necessary so a super-admin who clicks "Schedule for
  // 14:00 today" gets fanout that same hour, not at the next daily
  // tick.
  await financeDashboardQueue.add(
    FINANCE_DASHBOARD_JOBS.SURVEY_SEND,
    {},
    {
      jobId: "finance-survey-send-hourly",
      repeat: { pattern: "0 * * * *", tz: "UTC" },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  // Weekly survey-response retention sweep, Sunday 04:00 UTC — between
  // the constituent-count refresh and the EU morning login window so
  // an unexpectedly long sweep doesn't impact dashboard freshness.
  await financeDashboardQueue.add(
    FINANCE_DASHBOARD_JOBS.SURVEY_RETENTION,
    {},
    {
      jobId: "finance-survey-retention-weekly",
      repeat: { pattern: "0 4 * * 0", tz: "UTC" },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  // Epic #539 — daily merge-undo purge at 03:45 UTC (after the nightly
  // expiry/refresh crons, before the EU morning window). Deletes
  // `custom_field_merge_undo` rows past their 30-day expires_at. Fixed
  // `jobId` so worker restarts don't fan out duplicate schedules.
  await customFieldsQueue.add(
    CUSTOM_FIELD_JOBS.MERGE_UNDO_PURGE,
    {},
    {
      jobId: "custom-field-merge-undo-purge-daily",
      repeat: { pattern: "45 3 * * *", tz: "UTC" },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  // #443 — Monthly platform finance report auto-trigger. Fires at
  // 03:30 UTC on the 1st of each month (after the nightly crons settle,
  // before the EU morning login window). `jobId` is fixed so worker
  // restarts don't fan-out to duplicate repeatable schedules.
  await platformReportsQueue.add(
    PLATFORM_REPORTS_JOBS.MONTHLY_AUTO_TRIGGER,
    { mode: "single" } satisfies PlatformReportTriggerPayload,
    {
      jobId: "platform-report-auto-trigger-monthly",
      repeat: { pattern: "30 3 1 * *", tz: "UTC" },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  );

  // One-shot boot-time backfill — checks the last 12 calendar months and
  // idempotently enqueues any that are missing. `jobId` includes a
  // timestamp so each worker restart triggers its own warm-up (consistent
  // with the fx_cache startup pattern). The processor early-returns when
  // all 12 months already have live rows, making this a safe no-op.
  await platformReportsQueue.add(
    PLATFORM_REPORTS_JOBS.MONTHLY_AUTO_TRIGGER,
    { mode: "backfill" } satisfies PlatformReportTriggerPayload,
    {
      jobId: `platform-report-backfill-startup-${Date.now()}`,
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 20 },
    },
  );
}

/**
 * Process a domain event from the transactional outbox relay.
 *
 * Type-routing decisions live in the pure `routeDomainEvent` helper
 * (issue #152) so they can be unit-tested without booting any of the
 * worker singletons or Redis/BullMQ infrastructure below. This wrapper
 * keeps the side-effecting concerns — BullMQ enqueues, inline
 * processor invocations, log lines — and just dispatches on the
 * decision shape.
 */
async function processDomainEvent(job: Job): Promise<void> {
  const { id, tenantId, type, payload, traceparent } = job.data as {
    id: string;
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
    traceparent?: string;
  };

  // Prefer the W3C trace-id threaded from the API → outbox → relay. Falling
  // back to the outbox event id keeps historical jobs (pre-metadata column)
  // still queryable by a single correlator.
  const traceId = extractTraceId(traceparent) ?? id;

  const log = jobLogger({ tenantId, jobId: job.id, traceId });

  log.info({ eventType: type }, "Processing domain event");

  // Notification fanout (Epic #363, GLO-004) runs alongside the
  // existing routing decision. The helper is feature-flag-gated and
  // never throws — see `processors/notifications-fanout.ts` header. We
  // await so a slow PG roundtrip doesn't accumulate orphan promises,
  // but the existing receipt/email/branding routing below is not
  // blocked by a fanout failure (the helper logs and returns).
  await fanoutNotifications({ outboxId: id, tenantId, type, payload, traceparent });

  // GDPR erasure cascade (issue #439) — soft-error-only, runs
  // alongside the routing decision. The helper short-circuits on
  // non-`user.soft_deleted` events.
  await fanoutSurveyErasure({ outboxId: id, tenantId, type, payload, traceparent });

  const decision = routeDomainEvent({ id, tenantId, type, payload, traceparent });

  switch (decision.kind) {
    case "donation-receipt": {
      // Forward traceparent so the child job's jobLogger inherits the same
      // trace-id — Loki can reconstruct "API request → event → receipt".
      await receiptsQueue.add(
        "generate-receipt",
        {
          donationId: decision.donationId,
          orgId: decision.orgId,
          fiscalYear: new Date().getFullYear(),
          locale: "en",
          traceparent: decision.traceparent,
        },
        { jobId: `receipt-${decision.donationId}` },
      );
      log.info({ donationId: decision.donationId }, "Enqueued receipt generation");
      return;
    }

    case "campaign-documents": {
      await campaignsQueue.add(
        "generate-campaign-documents",
        {
          campaignId: decision.campaignId,
          orgId: decision.orgId,
          constituentIds: decision.constituentIds,
          traceparent: decision.traceparent,
        },
        { jobId: `campaign-docs-${decision.campaignId}` },
      );
      log.info({ campaignId: decision.campaignId }, "Enqueued campaign document generation");
      return;
    }

    case "postal-export": {
      await postalExportsQueue.add(
        "generate-postal-export",
        {
          exportId: decision.exportId,
          campaignId: decision.campaignId,
          orgId: decision.orgId,
          mode: decision.mode,
          traceparent: decision.traceparent,
        },
        { jobId: `postal-export-${decision.exportId}` },
      );
      log.info(
        { exportId: decision.exportId, campaignId: decision.campaignId, mode: decision.mode },
        "Enqueued postal export job",
      );
      return;
    }

    case "bulk-email": {
      // Issue #326 — the outbox payload only carries the bulk_email_jobs
      // row id. The processor reads subject/body/constituent_ids from that
      // row at job start so PII never lives in Redis and a resume job
      // picks up the freshest `delivered_constituent_ids` snapshot when
      // it computes "remaining".
      await emailsQueue.add(
        "send-bulk-email",
        {
          orgId: decision.orgId,
          bulkEmailJobId: decision.bulkEmailJobId,
          traceparent: decision.traceparent,
        },
        // Per-payload job id so a transactional retry of the outbox row
        // doesn't fan-out into duplicate sends.
        { jobId: `bulk-email-${decision.outboxId}` },
      );
      log.info(
        { outboxId: decision.outboxId, bulkEmailJobId: decision.bulkEmailJobId },
        "Enqueued bulk email dispatch",
      );
      return;
    }

    case "survey-invitation-email": {
      const result = await processSurveyInvitationEmail({
        invitationId: decision.invitationId,
        surveyId: decision.surveyId,
        surveySlug: decision.surveySlug,
        email: decision.email,
        userId: decision.userId,
        expiresAt: decision.expiresAt,
        source: decision.source,
        locale: decision.locale,
      });
      log.info(
        { invitationId: decision.invitationId, surveySlug: decision.surveySlug, ...result },
        "Survey invitation email dispatched",
      );
      return;
    }

    case "signup-email": {
      const result = await processSignupVerificationEmail({
        tenantId: decision.tenantId,
        invitationId: decision.invitationId,
        expiresAt: decision.expiresAt,
        locale: decision.locale,
      });
      // `not_found` / `already_accepted` are terminal no-ops (old token
      // rotated, or user already verified) — do not throw, the outbox
      // event is done.
      log.info({ invitationId: decision.invitationId, ...result }, "Signup email dispatched");
      return;
    }

    case "team-invite-email": {
      const result = await processTeamInviteEmail({
        tenantId: decision.tenantId,
        invitationId: decision.invitationId,
        inviterUserId: decision.inviterUserId,
        locale: decision.locale,
      });
      log.info(
        { invitationId: decision.invitationId, eventType: type, ...result },
        "Team-invite email dispatched",
      );
      return;
    }

    case "platform-admin-invite": {
      // Issue #254 — distinct from `team_invite` because the accept URL
      // points at `/admin/platform-admins/accept` (super-admin
      // onboarding), not `/invite/accept`.
      const result = await processPlatformAdminInviteEmail({
        invitationId: decision.invitationId,
        locale: decision.locale,
      });
      log.info(
        { invitationId: decision.invitationId, eventType: type, ...result },
        "Platform-admin invite dispatched",
      );
      return;
    }

    case "branding-process-asset": {
      await brandingQueue.add(
        BRANDING_EVENT_TYPES.PROCESS_ASSET,
        { assetId: decision.assetId, orgId: decision.orgId, traceparent: decision.traceparent },
        { jobId: `branding-process-${decision.assetId}` },
      );
      log.info({ assetId: decision.assetId }, "Enqueued branding asset pipeline");
      return;
    }

    case "branding-activate-logo": {
      await brandingQueue.add(
        BRANDING_EVENT_TYPES.ACTIVATE_LOGO,
        { assetId: decision.assetId, orgId: decision.orgId, traceparent: decision.traceparent },
        { jobId: `branding-activate-${decision.assetId}` },
      );
      log.info({ assetId: decision.assetId }, "Enqueued branding activate logo");
      return;
    }

    case "branding-gc-asset": {
      await brandingQueue.add(
        BRANDING_EVENT_TYPES.GC_ASSET,
        {
          assetId: decision.assetId,
          orgId: decision.orgId,
          prefix: decision.prefix,
          traceparent: decision.traceparent,
        },
        { jobId: `branding-gc-${decision.assetId}` },
      );
      log.info(
        { assetId: decision.assetId, prefix: decision.prefix },
        "Enqueued branding asset GC",
      );
      return;
    }

    case "keycloak-sync-org-logo": {
      await keycloakSyncQueue.add(
        BRANDING_EVENT_TYPES.KEYCLOAK_SYNC_ORG_LOGO,
        { orgId: decision.orgId, traceparent: decision.traceparent },
        // Per-tenant jobId so a flurry of activations + gc on the same
        // tenant collapses to a single sync (last-write-wins).
        { jobId: `kc-sync-org-logo-${decision.orgId}` },
      );
      log.info({ tenantId: decision.orgId }, "Enqueued KC org logo sync");
      return;
    }

    case "bulk-import": {
      // Epic #373 — outbox payload carries only the bulk_import_jobs row
      // id. The worker re-reads the row + downloads the file under
      // tenant RLS; PII never lives in Redis.
      await bulkImportQueue.add(
        "process-bulk-import",
        {
          orgId: decision.orgId,
          bulkImportJobId: decision.bulkImportJobId,
          traceparent: decision.traceparent,
        },
        // Per-payload job id so a transactional retry of the outbox row
        // doesn't fan-out into duplicate imports.
        { jobId: `bulk-import-${decision.outboxId}` },
      );
      log.info(
        { outboxId: decision.outboxId, bulkImportJobId: decision.bulkImportJobId },
        "Enqueued bulk import job",
      );
      return;
    }

    case "custom-field-option-merge": {
      // Epic #539 — deterministic per-merge job id: a transactional
      // retry of the outbox row collapses onto the same backfill job
      // instead of running the rewrite twice in parallel.
      await customFieldsQueue.add(
        CUSTOM_FIELD_JOBS.OPTION_MERGE_BACKFILL,
        {
          orgId: decision.orgId,
          mergeId: decision.mergeId,
          definitionId: decision.definitionId,
          sourceOptionId: decision.sourceOptionId,
          targetOptionId: decision.targetOptionId,
          requestedBy: decision.requestedBy,
          traceparent: decision.traceparent,
        },
        { jobId: `option-merge-${decision.mergeId}` },
      );
      log.info(
        { mergeId: decision.mergeId, definitionId: decision.definitionId },
        "Enqueued custom-field option-merge backfill",
      );
      return;
    }

    case "custom-field-option-merge-undo": {
      await customFieldsQueue.add(
        CUSTOM_FIELD_JOBS.OPTION_MERGE_UNDO_BACKFILL,
        {
          orgId: decision.orgId,
          mergeId: decision.mergeId,
          definitionId: decision.definitionId,
          sourceOptionId: decision.sourceOptionId,
          targetOptionId: decision.targetOptionId,
          requestedBy: decision.requestedBy,
          traceparent: decision.traceparent,
        },
        { jobId: `option-merge-undo-${decision.mergeId}` },
      );
      log.info(
        { mergeId: decision.mergeId, definitionId: decision.definitionId },
        "Enqueued custom-field option-merge undo",
      );
      return;
    }

    case "unhandled":
      log.warn({ eventType: decision.type }, "Unhandled event type");
      return;

    default: {
      // Exhaustiveness check (PR #358 review M4). If a new `kind` is
      // added to `RoutingDecision` and a matching `case` isn't added
      // here, TypeScript fails to narrow `decision` to `never` and
      // surfaces a compile error — turning "I added a routing kind
      // and forgot to wire it" into a build failure rather than a
      // silent no-op at runtime.
      const _exhaustive: never = decision;
      log.error(
        { decision: _exhaustive },
        "routeDomainEvent returned an unhandled RoutingDecision kind — switch is non-exhaustive",
      );
      return;
    }
  }
}

/** Start all queue workers */
function startWorkers() {
  const defaultJobOpts = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
  };

  /** Each Worker gets its own Redis connection per BullMQ best practices */
  // The receipts queue carries two job names: the per-donation
  // `generate-receipt` fan-out and the manual `receipts.rewrap_deks`
  // KEK-rotation sweep (issue #228). Routed by `job.name`, defaulting to
  // generation so historical jobs (pre-name-const) keep processing.
  const receiptsWorker = new Worker(
    QUEUE_NAMES.RECEIPTS,
    async (job: Job) => {
      if (job.name === RECEIPT_JOBS.REWRAP_DEKS) {
        // biome-ignore lint/suspicious/noExplicitAny: BullMQ Job is heterogeneously typed at runtime
        return processRewrapReceiptDeks(job as Job<any>);
      }
      // biome-ignore lint/suspicious/noExplicitAny: BullMQ Job is heterogeneously typed at runtime
      return processGenerateReceipt(job as Job<any>);
    },
    {
      connection: createRedisConnection(),
      concurrency: 5,
      ...defaultJobOpts,
    },
  );

  // Wrap the processor in an arrow so BullMQ's second-arg `token: string`
  // doesn't collide with the processor's optional `deps` parameter used
  // by the worker test suite (issue #326).
  const emailsWorker = new Worker(QUEUE_NAMES.EMAILS, (job) => processSendBulkEmail(job), {
    connection: createRedisConnection(),
    concurrency: 2,
    ...defaultJobOpts,
  });

  const gdprWorker = new Worker(QUEUE_NAMES.GDPR, processGdprErasure, {
    connection: createRedisConnection(),
    concurrency: 1,
    ...defaultJobOpts,
  });

  const campaignsWorker = new Worker(QUEUE_NAMES.CAMPAIGNS, processGenerateCampaignDocuments, {
    connection: createRedisConnection(),
    concurrency: 3,
    ...defaultJobOpts,
  });

  // Postal-export worker — concurrency 1 per process: each job streams a
  // multipart S3 upload AND drives PDFKit synchronously through up to a
  // few thousand recipients, so two concurrent jobs would compete for
  // both the upload bandwidth and the event loop. Scale by adding worker
  // pods, not concurrency.
  const postalExportsWorker = new Worker(QUEUE_NAMES.POSTAL_EXPORTS, processGeneratePostalExport, {
    connection: createRedisConnection(),
    concurrency: 1,
    ...defaultJobOpts,
  });

  const eventsWorker = new Worker(QUEUE_NAMES.EVENTS, processDomainEvent, {
    connection: createRedisConnection(),
    concurrency: 10,
    ...defaultJobOpts,
  });

  const webhooksWorker = new Worker(QUEUE_NAMES.WEBHOOKS, processStripeWebhook, {
    connection: createRedisConnection(),
    concurrency: 5,
    ...defaultJobOpts,
  });

  // Tenant-lifecycle carries two job names:
  //  - `tenant.provisional-admin-expire` — nightly repeatable expire pass.
  //  - `tenant.signup-resend` (F3) — deferred lookup-and-rotate for the
  //    public resend endpoint, kept off the HTTP request path so the
  //    response is constant-time and doesn't leak a match/no-match oracle.
  const tenantLifecycleWorker = new Worker(
    QUEUE_NAMES.TENANT_LIFECYCLE,
    async (job: Job) => {
      if (job.name === TENANT_LIFECYCLE_JOBS.SIGNUP_RESEND) {
        // biome-ignore lint/suspicious/noExplicitAny: BullMQ Job is heterogeneously typed at runtime
        return processSignupResend(job as Job<any>);
      }
      return processTenantLifecycle(job);
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
      ...defaultJobOpts,
    },
  );

  // ── Branding queue (Epic #286) ──────────────────────────────────────
  // The branding queue carries four job names — process / activate / gc
  // / nightly orphan-gc sweep (issue #291).
  // We route by `job.name` rather than splitting into per-name queues so
  // BullMQ's per-tenant jobId ordering (last-write-wins for the same
  // logical asset) stays trivial. Concurrency 1: each pipeline pegs
  // libvips and uploads four objects sequentially — adding workers
  // (pods) is the right scaling axis.
  const brandingWorker = new Worker(
    QUEUE_NAMES.BRANDING,
    async (job: Job) => {
      // biome-ignore lint/suspicious/noExplicitAny: BullMQ Job is heterogeneously typed at runtime
      const j = job as Job<any>;
      if (j.name === BRANDING_EVENT_TYPES.PROCESS_ASSET) {
        return processBrandingAsset(j);
      }
      if (j.name === BRANDING_EVENT_TYPES.ACTIVATE_LOGO) {
        return processBrandingActivateLogo(j);
      }
      if (j.name === BRANDING_EVENT_TYPES.GC_ASSET) {
        return processBrandingGcAsset(j);
      }
      if (j.name === BRANDING_EVENT_TYPES.ORPHAN_GC_SWEEP) {
        return processBrandingOrphanGcSweep(j);
      }
      logger.warn({ jobName: j.name }, "Unknown branding job — skipping");
      return null;
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
      ...defaultJobOpts,
    },
  );

  // ── Bulk-import queue (Epic #373) ────────────────────────────────────
  // Concurrency 1 per pod: each job buffers a sub-10 MB file in memory
  // and walks rows sequentially under one Drizzle txn per batch. The
  // CPU floor is the trigram duplicate-detection query — scale by adding
  // pods, not concurrency.
  const bulkImportWorker = new Worker(
    QUEUE_NAMES.BULK_IMPORT,
    (job) =>
      processBulkImport(
        job as Job<{ orgId: string; bulkImportJobId: string; traceparent?: string }>,
      ),
    {
      connection: createRedisConnection(),
      concurrency: 1,
      ...defaultJobOpts,
    },
  );

  // ── Custom-fields queue (Epic #539) ─────────────────────────────────
  // Two job names: the option-merge backfill (chunked JSONB rewrite) and
  // the daily merge-undo purge. Concurrency 1 — a backfill walks the
  // domain table in 500-row transactions and must not race a second
  // merge on the same definition; scale by adding pods, not concurrency.
  const customFieldsWorker = new Worker(
    CUSTOM_FIELDS_QUEUE,
    async (job: Job) => {
      if (job.name === CUSTOM_FIELD_JOBS.OPTION_MERGE_BACKFILL) {
        // biome-ignore lint/suspicious/noExplicitAny: BullMQ Job is heterogeneously typed at runtime
        return processCustomFieldOptionMerge(job as Job<any>);
      }
      if (job.name === CUSTOM_FIELD_JOBS.OPTION_MERGE_UNDO_BACKFILL) {
        // biome-ignore lint/suspicious/noExplicitAny: BullMQ Job is heterogeneously typed at runtime
        return processCustomFieldOptionMergeUndo(job as Job<any>);
      }
      if (job.name === CUSTOM_FIELD_JOBS.MERGE_UNDO_PURGE) {
        return processCustomFieldUndoPurge(job);
      }
      logger.warn({ jobName: job.name }, "Unknown custom-fields job — skipping");
      return null;
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
      ...defaultJobOpts,
    },
  );

  const keycloakSyncWorker = new Worker(
    QUEUE_NAMES.KEYCLOAK_SYNC,
    async (job: Job) => {
      // biome-ignore lint/suspicious/noExplicitAny: BullMQ Job is heterogeneously typed at runtime
      const j = job as Job<any>;
      if (j.name === BRANDING_EVENT_TYPES.KEYCLOAK_SYNC_ORG_LOGO) {
        return processKeycloakSyncOrgLogo(j);
      }
      logger.warn({ jobName: j.name }, "Unknown keycloak-sync job — skipping");
      return null;
    },
    {
      connection: createRedisConnection(),
      // Concurrency 2: KC admin calls are network-bound; we don't want
      // a slow KC making logo syncs block forever, but we also don't
      // want 10 concurrent attribute writes contesting the same org.
      concurrency: 2,
      ...defaultJobOpts,
    },
  );

  // Notifications email digest (Epic #363, Phase 5).
  const notificationsDigestWorker = new Worker(
    QUEUE_NAMES.NOTIFICATIONS_DIGEST,
    async (job: Job) => processNotificationsEmailDigest(job),
    {
      connection: createRedisConnection(),
      // Concurrency 1: opt-in distribution is small and we'd rather
      // not flood the SMTP relay. Scale by adding worker pods if a
      // large tenant ever opts every member into the digest.
      concurrency: 1,
      ...defaultJobOpts,
    },
  );

  // #436 — Super-admin finance dashboard enrichment worker.
  // Concurrency 1: all three job names are platform-wide sweeps that
  // must not race themselves (constituent count UPDATEs against every
  // tenant in turn; survey send claims pending invitations
  // idempotently but a duplicate sweep would still log noisy "already
  // existing" skips). Scale by adding pods, not concurrency.
  const financeDashboardWorker = new Worker(
    QUEUE_NAMES.FINANCE_DASHBOARD,
    async (job: Job) => {
      if (job.name === FINANCE_DASHBOARD_JOBS.CONSTITUENT_COUNT_REFRESH) {
        return processConstituentCountRefresh(job);
      }
      if (job.name === FINANCE_DASHBOARD_JOBS.SURVEY_SEND) {
        return processSurveySend(job);
      }
      if (job.name === FINANCE_DASHBOARD_JOBS.SURVEY_RETENTION) {
        return processSurveyRetention(job);
      }
      logger.warn({ jobName: job.name }, "Unknown finance-dashboard job — skipping");
      return null;
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
      ...defaultJobOpts,
    },
  );

  // Issue #443 — Monthly platform finance report PDF generation.
  // Concurrency 1 per process: each job runs a PDFKit render + a
  // multipart S3 upload; the work is bound by S3 upload latency more
  // than CPU. Scale by adding worker pods, not concurrency. The
  // partial unique index on the live rows means at most one
  // in-flight job per month anyway.
  const platformReportsWorker = new Worker(
    QUEUE_NAMES.PLATFORM_REPORTS,
    async (job: Job) => {
      if (job.name === PLATFORM_REPORTS_JOBS.MONTHLY_AUTO_TRIGGER) {
        return processPlatformReportAutoTrigger(job as Job<PlatformReportTriggerPayload>);
      }
      return processGenerateMonthlyFinanceReport(
        job as Job<{ reportId: string; month: string; traceparent?: string }>,
      );
    },
    {
      connection: createRedisConnection(),
      concurrency: 1,
      ...defaultJobOpts,
    },
  );

  const workers = [
    receiptsWorker,
    emailsWorker,
    gdprWorker,
    campaignsWorker,
    postalExportsWorker,
    eventsWorker,
    webhooksWorker,
    tenantLifecycleWorker,
    brandingWorker,
    customFieldsWorker,
    keycloakSyncWorker,
    notificationsDigestWorker,
    bulkImportWorker,
    financeDashboardWorker,
    platformReportsWorker,
  ];

  for (const w of workers) {
    w.on("completed", (job) => {
      logger.info({ worker: w.name, jobId: job.id }, "Job completed");
    });
    w.on("failed", (job, err) => {
      // Distinguish TRANSIENT failures (will be retried) from TERMINAL failures
      // (attempts exhausted → job is on its way to BullMQ's `failed` set).
      // The terminal case is a Dead-Letter event and demands an alert-worthy
      // log line so Loki can fire on it. See docs/17 §DLQ and
      // docs/adrs/adr-020-bullmq-dead-letter-strategy-failed-set-structured-alerting-for-phase-1.md
      // (Accepted).
      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = job?.opts?.attempts ?? 1;
      const terminal = attemptsMade >= maxAttempts;
      const payload = {
        worker: w.name,
        jobId: job?.id,
        jobName: job?.name,
        tenantId: (job?.data as { tenantId?: string } | undefined)?.tenantId,
        attemptsMade,
        maxAttempts,
        err: err.message,
        stack: err.stack,
      };
      if (terminal) {
        logger.error({ ...payload, dlq: true }, "Job failed terminally (DLQ candidate)");
      } else {
        logger.warn(payload, "Job failed (will retry)");
      }
    });
  }

  logger.info({ workers: workers.map((w) => w.name) }, "Workers started");
}

// Issue #430 — boot-time tenant-isolation guard. A misconfigured
// DATABASE_URL_APP (e.g. pointing at the owner role with BYPASSRLS, as
// happened on staging on 2026-05-23) silently disables RLS across
// every worker query. Crash fast before any job runs so the breakage
// is a deploy failure, never a silent cross-tenant leak.
async function main() {
  await assertWorkerAppRoleSecure();
  startWorkers();
  await scheduleRepeatableJobs();
}

main().catch((err) => {
  logger.error({ err }, "Worker failed to start");
  process.exit(1);
});
