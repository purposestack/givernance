/** BullMQ Worker entry point — registers all job processors */

import { BRANDING_EVENT_TYPES, QUEUE_NAMES, TENANT_LIFECYCLE_JOBS } from "@givernance/shared/jobs";
import type { Job } from "bullmq";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "./env.js";
import { jobLogger, logger } from "./lib/logger.js";
import { resolvePayloadLocale } from "./lib/payload-locale.js";
import { extractTraceId } from "./lib/trace-context.js";
import { processBrandingActivateLogo } from "./processors/branding-activate-logo.js";
import { processBrandingGcAsset } from "./processors/branding-gc-asset.js";
import { processBrandingAsset } from "./processors/branding-process-asset.js";
import { processGenerateCampaignDocuments } from "./processors/campaign-documents.js";
import { processGdprErasure } from "./processors/gdpr-erasure.js";
import { processGenerateReceipt } from "./processors/generate-receipt.js";
import { processKeycloakSyncOrgLogo } from "./processors/keycloak-sync-org-logo.js";
import { processPlatformAdminInviteEmail } from "./processors/platform-admin-invite-email.js";
import { processGeneratePostalExport } from "./processors/postal-export.js";
import { processSendBulkEmail } from "./processors/send-bulk-email.js";
import {
  processSignupVerificationEmail,
  type SignupEmailJobPayload,
} from "./processors/signup-email.js";
import { processStripeWebhook } from "./processors/stripe-webhook.js";
import {
  processTeamInviteEmail,
  type TeamInviteEmailJobPayload,
} from "./processors/team-invite-email.js";
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

/**
 * Register the nightly provisional-admin expire job.
 *
 * Runs at 03:15 UTC daily — after the busy EU evening window, before the
 * morning support shift. `jobId` is fixed so re-registering across worker
 * restarts doesn't fan-out to duplicate repeatable schedules.
 */
async function scheduleRepeatableJobs() {
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
}

/**
 * Route the four branding-related outbox events to their queues.
 * Returns `true` when the event was handled (the caller short-circuits)
 * and `false` when the type doesn't match — keeps `processDomainEvent`
 * under Biome's cognitive complexity ceiling.
 */
async function routeBrandingEvent(args: {
  type: string;
  payload: Record<string, unknown>;
  tenantId: string;
  traceparent?: string;
  log: ReturnType<typeof jobLogger>;
}): Promise<boolean> {
  const { type, payload, tenantId, traceparent, log } = args;
  if (type === BRANDING_EVENT_TYPES.PROCESS_ASSET) {
    const assetId = payload.assetId as string;
    await brandingQueue.add(
      BRANDING_EVENT_TYPES.PROCESS_ASSET,
      { assetId, orgId: tenantId, traceparent },
      { jobId: `branding-process-${assetId}` },
    );
    log.info({ assetId }, "Enqueued branding asset pipeline");
    return true;
  }
  if (type === BRANDING_EVENT_TYPES.ACTIVATE_LOGO) {
    const assetId = payload.assetId as string;
    await brandingQueue.add(
      BRANDING_EVENT_TYPES.ACTIVATE_LOGO,
      { assetId, orgId: tenantId, traceparent },
      { jobId: `branding-activate-${assetId}` },
    );
    log.info({ assetId }, "Enqueued branding activate logo");
    return true;
  }
  if (type === BRANDING_EVENT_TYPES.GC_ASSET) {
    const assetId = payload.assetId as string;
    const prefix = payload.prefix as string;
    await brandingQueue.add(
      BRANDING_EVENT_TYPES.GC_ASSET,
      { assetId, orgId: tenantId, prefix, traceparent },
      { jobId: `branding-gc-${assetId}` },
    );
    log.info({ assetId, prefix }, "Enqueued branding asset GC");
    return true;
  }
  if (type === BRANDING_EVENT_TYPES.KEYCLOAK_SYNC_ORG_LOGO) {
    await keycloakSyncQueue.add(
      BRANDING_EVENT_TYPES.KEYCLOAK_SYNC_ORG_LOGO,
      { orgId: tenantId, traceparent },
      // Per-tenant jobId so a flurry of activations + gc on the same
      // tenant collapses to a single sync (last-write-wins).
      { jobId: `kc-sync-org-logo-${tenantId}` },
    );
    log.info({ tenantId }, "Enqueued KC org logo sync");
    return true;
  }
  return false;
}

/**
 * Process a domain event from the transactional outbox relay.
 * Routes events to specific handlers based on type.
 *
 * Locale-resolution helper extracted to `./lib/payload-locale.ts` so it
 * can be unit-tested without booting the worker singletons below
 * (issue #153 / PR #158 review).
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

  if (type === "donation.created") {
    const donationId = payload.donationId as string;
    const fiscalYear = new Date().getFullYear();

    // Forward traceparent so the child job's jobLogger inherits the same
    // trace-id — Loki can reconstruct "API request → event → receipt".
    await receiptsQueue.add(
      "generate-receipt",
      {
        donationId,
        orgId: tenantId,
        fiscalYear,
        locale: "en",
        traceparent,
      },
      { jobId: `receipt-${donationId}` },
    );

    log.info({ donationId }, "Enqueued receipt generation");
    return;
  }

  if (type === "campaign.documents_requested") {
    const campaignId = payload.campaignId as string;
    const constituentIds = payload.constituentIds as string[];

    await campaignsQueue.add(
      "generate-campaign-documents",
      {
        campaignId,
        orgId: tenantId,
        constituentIds,
        traceparent,
      },
      { jobId: `campaign-docs-${campaignId}` },
    );

    log.info({ campaignId }, "Enqueued campaign document generation");
    return;
  }

  if (type === "campaign.postal_export_requested") {
    const campaignId = payload.campaignId as string;
    const exportId = payload.exportId as string;
    const mode = payload.mode as "door_drop" | "personalized";

    await postalExportsQueue.add(
      "generate-postal-export",
      {
        exportId,
        campaignId,
        orgId: tenantId,
        mode,
        traceparent,
      },
      { jobId: `postal-export-${exportId}` },
    );

    log.info({ exportId, campaignId, mode }, "Enqueued postal export job");
    return;
  }

  if (type === "communication.bulk_email_requested") {
    await emailsQueue.add(
      "send-bulk-email",
      {
        orgId: tenantId,
        templateId: "ad-hoc-bulk-email",
        segmentFilter: {
          subject: payload.subject,
          body: payload.body,
          // Forward only the constituent id list — PII (email, name) is
          // re-resolved by the processor at send time so it never lives
          // in Redis. See `bulk-email-service.ts` for the GDPR Art. 5(1)(e)
          // rationale.
          constituentIds: payload.constituentIds,
          requestedBy: payload.requestedBy,
        },
        traceparent,
      },
      // Per-payload job id so a transactional retry of the outbox row
      // doesn't fan-out into duplicate sends.
      { jobId: `bulk-email-${id}` },
    );

    log.info({ outboxId: id }, "Enqueued bulk email dispatch");
    return;
  }

  if (
    type === "tenant.signup_verification_requested" ||
    type === "tenant.signup_verification_resent"
  ) {
    const emailPayload: SignupEmailJobPayload = {
      tenantId,
      invitationId: payload.invitationId as string,
      expiresAt: payload.expiresAt as string,
      locale: resolvePayloadLocale(payload),
    };
    const result = await processSignupVerificationEmail(emailPayload);
    // `not_found` / `already_accepted` are terminal no-ops (old token rotated,
    // or user already verified) — do not throw, the outbox event is done.
    log.info({ invitationId: emailPayload.invitationId, ...result }, "Signup email dispatched");
    return;
  }

  if (
    type === "invitation.created" ||
    type === "invitation.resent" ||
    type === "tenant.first_admin_invited"
  ) {
    const invitationId = payload.invitationId as string;
    const inviterUserId = typeof payload.inviterUserId === "string" ? payload.inviterUserId : null;
    const emailPayload: TeamInviteEmailJobPayload = {
      tenantId,
      invitationId,
      inviterUserId,
      locale: resolvePayloadLocale(payload),
    };
    const result = await processTeamInviteEmail(emailPayload);
    log.info({ invitationId, eventType: type, ...result }, "Team-invite email dispatched");
    return;
  }

  // ── Org branding (Epic #286) ───────────────────────────────────────
  // Routed through a helper so the parent function's cognitive
  // complexity stays under the Biome cap.
  if (await routeBrandingEvent({ type, payload, tenantId, traceparent, log })) {
    return;
  }

  // Issue #254 — platform-admin invitation. Distinct from `team_invite`
  // because the accept URL points at `/admin/platform-admins/accept`
  // (super-admin onboarding), not `/invite/accept`.
  if (type === "platform_admin.invited") {
    const invitationId = payload.invitationId as string;
    const result = await processPlatformAdminInviteEmail({
      invitationId,
      locale: resolvePayloadLocale(payload),
    });
    log.info({ invitationId, eventType: type, ...result }, "Platform-admin invite dispatched");
    return;
  }

  log.warn({ eventType: type }, "Unhandled event type");
}

/** Start all queue workers */
function startWorkers() {
  const defaultJobOpts = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5000 },
  };

  /** Each Worker gets its own Redis connection per BullMQ best practices */
  const receiptsWorker = new Worker(QUEUE_NAMES.RECEIPTS, processGenerateReceipt, {
    connection: createRedisConnection(),
    concurrency: 5,
    ...defaultJobOpts,
  });

  const emailsWorker = new Worker(QUEUE_NAMES.EMAILS, processSendBulkEmail, {
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

  const tenantLifecycleWorker = new Worker(QUEUE_NAMES.TENANT_LIFECYCLE, processTenantLifecycle, {
    connection: createRedisConnection(),
    concurrency: 1,
    ...defaultJobOpts,
  });

  // ── Branding queue (Epic #286) ──────────────────────────────────────
  // The branding queue carries three job names — process / activate / gc.
  // We route by `job.name` rather than splitting into three queues so
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
      logger.warn({ jobName: j.name }, "Unknown branding job — skipping");
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
    keycloakSyncWorker,
  ];

  for (const w of workers) {
    w.on("completed", (job) => {
      logger.info({ worker: w.name, jobId: job.id }, "Job completed");
    });
    w.on("failed", (job, err) => {
      // Distinguish TRANSIENT failures (will be retried) from TERMINAL failures
      // (attempts exhausted → job is on its way to BullMQ's `failed` set).
      // The terminal case is a Dead-Letter event and demands an alert-worthy
      // log line so Loki/Sentry can fire on it. See docs/17 §DLQ and
      // follow-up ADR drafted in issue #56.
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

startWorkers();
scheduleRepeatableJobs().catch((err) => {
  logger.error({ err }, "Failed to schedule repeatable jobs");
});
