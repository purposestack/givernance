/**
 * Unit tests — shared BullMQ default job options (issue #612).
 * Pure data; no Redis, no BullMQ.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_JOB_OPTIONS, defaultJobOptionsFor, QUEUE_NAMES } from "../jobs/index.js";

describe("defaultJobOptionsFor", () => {
  it("gives every queue bounded retention on both the completed and failed sets", () => {
    for (const name of Object.values(QUEUE_NAMES)) {
      const opts = defaultJobOptionsFor(name);
      expect(opts.removeOnComplete.age, name).toBeGreaterThan(0);
      expect(opts.removeOnComplete.count, name).toBeGreaterThan(0);
      expect(opts.removeOnFail.age, name).toBeGreaterThan(0);
      expect(opts.removeOnFail.count, name).toBeGreaterThan(0);
      expect(opts.attempts, name).toBeGreaterThanOrEqual(1);
    }
  });

  it("retries with exponential backoff by default", () => {
    const opts = defaultJobOptionsFor(QUEUE_NAMES.RECEIPTS);
    expect(opts).toEqual(DEFAULT_JOB_OPTIONS);
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: "exponential", delay: 30_000 });
  });

  it("keeps bulk-import at a single attempt (processor is not resume-safe) but bounds retention", () => {
    const opts = defaultJobOptionsFor(QUEUE_NAMES.BULK_IMPORT);
    expect(opts.attempts).toBe(1);
    expect(opts.removeOnComplete).toEqual(DEFAULT_JOB_OPTIONS.removeOnComplete);
    expect(opts.removeOnFail).toEqual(DEFAULT_JOB_OPTIONS.removeOnFail);
  });

  it("drops completed Stripe webhook jobs (donor PII) faster than the baseline, still retrying", () => {
    const opts = defaultJobOptionsFor(QUEUE_NAMES.WEBHOOKS);
    expect(opts.attempts).toBe(3);
    expect(opts.removeOnComplete.age).toBeLessThan(DEFAULT_JOB_OPTIONS.removeOnComplete.age);
    expect(opts.removeOnFail).toEqual(DEFAULT_JOB_OPTIONS.removeOnFail);
  });

  it("falls back to the baseline for an unknown queue name and never mutates it", () => {
    const opts = defaultJobOptionsFor("not-a-queue");
    expect(opts).toEqual(DEFAULT_JOB_OPTIONS);
    expect(opts).not.toBe(DEFAULT_JOB_OPTIONS);
  });
});
