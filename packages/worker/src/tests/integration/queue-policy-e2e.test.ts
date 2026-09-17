/**
 * Real BullMQ + Redis regression tests for the queue policy (issue #612).
 *
 * These pin the two BullMQ behaviours the worker got wrong, against the
 * installed BullMQ rather than against our reading of its docs:
 *
 *   1. Retry policy is read from the producing QUEUE's `defaultJobOptions`
 *      (merged into `job.opts` at `add()` time). `attempts` / `backoff`
 *      passed to a `Worker` constructor are ignored — that is how most
 *      queues silently ran with zero retries.
 *   2. `add()` with a `jobId` that matches a job in ANY state — including a
 *      retained `completed` one — is dropped. A per-entity id on a job that
 *      legitimately recurs therefore runs once, ever; the outbox-event-keyed
 *      ids from `lib/job-ids.ts` do not have that problem.
 *
 * Unique queue names per run + `obliterate` keep this isolated on a shared
 * Redis.
 */

import { randomUUID } from "node:crypto";
import { defaultJobOptionsFor, QUEUE_NAMES } from "@givernance/shared/jobs";
import { Queue, QueueEvents, Worker } from "bullmq";
import Redis from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { campaignDocumentsJobId, keycloakSyncOrgLogoJobId } from "../../lib/job-ids.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const RUN_ID = randomUUID();

function newConnection(): Redis {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

describe("queue policy against real BullMQ (issue #612)", () => {
  const queueConnection = newConnection();
  const eventsConnection = newConnection();

  afterAll(async () => {
    await Promise.all([queueConnection.quit(), eventsConnection.quit()]);
  });

  it("stamps the shared defaults onto every job added through the queue handle", async () => {
    const queue = new Queue(`policy-${RUN_ID}-stamp`, {
      connection: queueConnection,
      defaultJobOptions: defaultJobOptionsFor(QUEUE_NAMES.RECEIPTS),
    });
    try {
      const job = await queue.add("generate-receipt", { donationId: "d" }, { jobId: "receipt-d" });
      expect(job.opts.attempts).toBe(3);
      expect(job.opts.backoff).toEqual({ type: "exponential", delay: 30_000 });
      expect(job.opts.removeOnComplete).toEqual({ age: 86_400, count: 1000 });
      expect(job.opts.removeOnFail).toEqual({ age: 14 * 86_400, count: 500 });

      // Per-add options still win (the API's signup-resend pins attempts: 1).
      const pinned = await queue.add("x", {}, { attempts: 1 });
      expect(pinned.opts.attempts).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("retries a failing job when the QUEUE carries attempts — Worker-level attempts do nothing", async () => {
    const withDefaults = `policy-${RUN_ID}-retry-on`;
    const withoutDefaults = `policy-${RUN_ID}-retry-off`;
    const retryingQueue = new Queue(withDefaults, {
      connection: queueConnection,
      defaultJobOptions: {
        ...defaultJobOptionsFor(QUEUE_NAMES.WEBHOOKS),
        // Same attempt count as production, test-sized backoff.
        backoff: { type: "fixed", delay: 25 },
      },
    });
    const bareQueue = new Queue(withoutDefaults, { connection: queueConnection });
    const retryingEvents = new QueueEvents(withDefaults, { connection: eventsConnection });
    const bareEventsConnection = newConnection();
    const bareEvents = new QueueEvents(withoutDefaults, { connection: bareEventsConnection });
    await Promise.all([retryingEvents.waitUntilReady(), bareEvents.waitUntilReady()]);

    const runs: Record<string, number> = { [withDefaults]: 0, [withoutDefaults]: 0 };
    const flakyOnce = (name: string) => async () => {
      runs[name] = (runs[name] ?? 0) + 1;
      if (runs[name] === 1) throw new Error("transient PG flake");
      return { ok: true };
    };

    const c1 = newConnection();
    const c2 = newConnection();
    const retryingWorker = new Worker(withDefaults, flakyOnce(withDefaults), { connection: c1 });
    // The pre-#612 wiring: retry opts spread into the Worker constructor
    // (a spread sidesteps the excess-property check, which is why it
    // type-checked for so long).
    const ignoredRetryOpts = { attempts: 3, backoff: { type: "fixed", delay: 25 } };
    const bareWorker = new Worker(withoutDefaults, flakyOnce(withoutDefaults), {
      connection: c2,
      ...ignoredRetryOpts,
    });

    try {
      const retried = await retryingQueue.add("process-stripe-webhook", {});
      const lost = await bareQueue.add("process-stripe-webhook", {});

      await expect(retried.waitUntilFinished(retryingEvents)).resolves.toEqual({ ok: true });
      await expect(lost.waitUntilFinished(bareEvents)).rejects.toThrow("transient PG flake");

      expect(runs[withDefaults]).toBe(2);
      expect(runs[withoutDefaults]).toBe(1);
    } finally {
      await Promise.all([retryingWorker.close(), bareWorker.close()]);
      await Promise.all([retryingEvents.close(), bareEvents.close()]);
      await Promise.all([c1.quit(), c2.quit(), bareEventsConnection.quit()]);
      await retryingQueue.obliterate({ force: true });
      await bareQueue.obliterate({ force: true });
      await Promise.all([retryingQueue.close(), bareQueue.close()]);
    }
  });

  it("a per-entity jobId is burned by the retained completed job; outbox-keyed ids are not", async () => {
    const queueName = `policy-${RUN_ID}-jobid`;
    const queue = new Queue(queueName, {
      connection: queueConnection,
      defaultJobOptions: defaultJobOptionsFor(QUEUE_NAMES.KEYCLOAK_SYNC),
    });
    const events = new QueueEvents(queueName, { connection: eventsConnection });
    await events.waitUntilReady();

    const processed: string[] = [];
    const workerConnection = newConnection();
    const worker = new Worker(
      queueName,
      async (job) => {
        processed.push(job.id ?? "");
        return null;
      },
      { connection: workerConnection },
    );

    const orgId = randomUUID();
    const perTenantId = `kc-sync-org-logo-${orgId}`; // the pre-#612 id
    try {
      // First logo change for the tenant — runs.
      const first = await queue.add("keycloak.sync_org_logo", { orgId }, { jobId: perTenantId });
      await first.waitUntilFinished(events);

      // Second logo change, same per-tenant id — BullMQ hands back the
      // retained completed job and enqueues nothing.
      const second = await queue.add("keycloak.sync_org_logo", { orgId }, { jobId: perTenantId });
      expect(await second.getState()).toBe("completed");

      // Outbox-keyed ids: two events for the SAME tenant both run…
      const [eventA, eventB] = [randomUUID(), randomUUID()];
      const a = await queue.add(
        "keycloak.sync_org_logo",
        { orgId },
        { jobId: keycloakSyncOrgLogoJobId(eventA) },
      );
      const b = await queue.add(
        "keycloak.sync_org_logo",
        { orgId },
        { jobId: keycloakSyncOrgLogoJobId(eventB) },
      );
      await Promise.all([a.waitUntilFinished(events), b.waitUntilFinished(events)]);

      // …while a relay redelivery of the same outbox row still collapses.
      const redelivered = await queue.add(
        "keycloak.sync_org_logo",
        { orgId },
        { jobId: keycloakSyncOrgLogoJobId(eventA) },
      );
      expect(await redelivered.getState()).toBe("completed");

      expect(processed).toEqual([
        perTenantId,
        keycloakSyncOrgLogoJobId(eventA),
        keycloakSyncOrgLogoJobId(eventB),
      ]);
    } finally {
      await worker.close();
      await workerConnection.quit();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it("derives distinct ids per outbox event and never embeds the entity id", () => {
    const [e1, e2] = [randomUUID(), randomUUID()];
    expect(keycloakSyncOrgLogoJobId(e1)).toBe(`kc-sync-org-logo-${e1}`);
    expect(campaignDocumentsJobId(e1)).toBe(`campaign-docs-${e1}`);
    expect(keycloakSyncOrgLogoJobId(e1)).not.toBe(keycloakSyncOrgLogoJobId(e2));
    expect(campaignDocumentsJobId(e1)).not.toBe(campaignDocumentsJobId(e2));
  });
});
