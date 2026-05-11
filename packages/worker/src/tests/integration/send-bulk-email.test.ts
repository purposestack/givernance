/**
 * Worker integration tests for the bulk-email processor (issue #326).
 *
 * Focus: per-recipient outcome tracking + terminal status flip. The
 * `bulk_email_jobs` row must end the run with delivered/failed counters
 * that match the array contents AND a status that reflects the actual
 * delivery outcome (completed vs. partial).
 *
 * SMTP is stubbed at the EmailSender boundary — no real Mailpit, no real
 * Resend HTTP traffic. That keeps the test deterministic AND lets us
 * inject per-recipient failures to exercise the partial-send path.
 */

import { bulkEmailJobs, constituents, tenants } from "@givernance/shared/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../lib/db.js";
import type { EmailSender, SendEmailInput } from "../../lib/email.js";
import { processSendBulkEmail } from "../../processors/send-bulk-email.js";

// Dedicated tenant id so this file's fixtures never collide with the
// other worker integration tests (file-level parallelism is off, but
// defensive — same posture as postal-export.test.ts).
const ORG_ID = "00000000-0000-0000-0000-00000000007b";

let constituentAId: string;
let constituentBId: string;
let constituentCId: string;

function makeMockJob(data: Record<string, unknown>) {
  return {
    data,
    id: `test-bulk-email-job-${Math.random().toString(16).slice(2)}`,
    attemptsMade: 0,
    log: vi.fn(),
  } as never;
}

/** Insert a `bulk_email_jobs` row in `pending` state and return its id. */
async function seedJob(args: {
  status?: "pending" | "processing" | "partial" | "failed";
  constituentIds: string[];
  delivered?: string[];
  failed?: string[];
}): Promise<string> {
  const delivered = args.delivered ?? [];
  const failed = args.failed ?? [];
  const [row] = await db
    .insert(bulkEmailJobs)
    .values({
      orgId: ORG_ID,
      status: args.status ?? "pending",
      subject: "Worker test",
      body: "Hi {firstName},\n\nThanks for your support.",
      constituentIds: args.constituentIds,
      deliveredConstituentIds: delivered,
      failedConstituentIds: failed,
      totalRecipients: args.constituentIds.length,
      deliveredCount: delivered.length,
      failedCount: failed.length,
    })
    .returning({ id: bulkEmailJobs.id });
  if (!row) throw new Error("Failed to seed bulk_email_jobs row");
  return row.id;
}

beforeAll(async () => {
  await db.execute(
    sql`INSERT INTO tenants (id, name, slug) VALUES (${ORG_ID}, 'Bulk Worker Org', 'bulk-worker') ON CONFLICT (id) DO NOTHING`,
  );

  const [a, b, c] = await db
    .insert(constituents)
    .values([
      {
        orgId: ORG_ID,
        firstName: "Alice",
        lastName: "Bulk",
        email: "alice.bulk@example.org",
        type: "donor",
      },
      {
        orgId: ORG_ID,
        firstName: "Bob",
        lastName: "Bulk",
        email: "bob.bulk@example.org",
        type: "donor",
      },
      {
        orgId: ORG_ID,
        firstName: "Carol",
        lastName: "Bulk",
        email: "carol.bulk@example.org",
        type: "donor",
      },
    ])
    .returning();
  constituentAId = a!.id;
  constituentBId = b!.id;
  constituentCId = c!.id;
});

afterAll(async () => {
  // Clean up so re-runs are deterministic. Tenant cascade handles
  // constituents + bulk_email_jobs.
  await db.delete(tenants).where(eq(tenants.id, ORG_ID));
});

beforeEach(async () => {
  // Wipe any rows leftover from a previous test in this file so the
  // assertions below operate on freshly-seeded data.
  await db.execute(sql`DELETE FROM bulk_email_jobs WHERE org_id = ${ORG_ID}::uuid`);
});

function recordingSender(failingEmails: Set<string> = new Set()): {
  sender: EmailSender;
  sends: SendEmailInput[];
} {
  const sends: SendEmailInput[] = [];
  const sender: EmailSender = {
    async send(input) {
      sends.push(input);
      if (failingEmails.has(input.to)) {
        throw new Error(`SMTP refused ${input.to}`);
      }
    },
  };
  return { sender, sends };
}

describe("processSendBulkEmail — issue #326 per-recipient tracking", () => {
  it("marks the job `completed` and updates delivered_count when every recipient succeeds", async () => {
    const jobId = await seedJob({ constituentIds: [constituentAId, constituentBId] });
    const { sender, sends } = recordingSender();

    const result = await processSendBulkEmail(
      makeMockJob({ orgId: ORG_ID, bulkEmailJobId: jobId }),
      { emailSender: sender },
    );

    expect(result).toEqual({ sent: 2, failed: 0, skipped: 0 });
    expect(sends.map((s) => s.to).sort()).toEqual([
      "alice.bulk@example.org",
      "bob.bulk@example.org",
    ]);

    const [row] = await db
      .select({
        status: bulkEmailJobs.status,
        deliveredCount: bulkEmailJobs.deliveredCount,
        failedCount: bulkEmailJobs.failedCount,
        deliveredConstituentIds: bulkEmailJobs.deliveredConstituentIds,
        failedConstituentIds: bulkEmailJobs.failedConstituentIds,
        completedAt: bulkEmailJobs.completedAt,
      })
      .from(bulkEmailJobs)
      .where(eq(bulkEmailJobs.id, jobId));
    expect(row?.status).toBe("completed");
    expect(row?.deliveredCount).toBe(2);
    expect(row?.failedCount).toBe(0);
    expect(row?.deliveredConstituentIds?.sort()).toEqual([constituentAId, constituentBId].sort());
    expect(row?.failedConstituentIds).toEqual([]);
    expect(row?.completedAt).not.toBeNull();
  });

  it("marks the job `partial` when some recipients fail at the SMTP layer", async () => {
    const jobId = await seedJob({
      constituentIds: [constituentAId, constituentBId, constituentCId],
    });
    // Bob's send blows up — the loop records him in failed_constituent_ids
    // and proceeds with the others.
    const { sender, sends } = recordingSender(new Set(["bob.bulk@example.org"]));

    const result = await processSendBulkEmail(
      makeMockJob({ orgId: ORG_ID, bulkEmailJobId: jobId }),
      { emailSender: sender },
    );

    expect(result).toEqual({ sent: 2, failed: 1, skipped: 0 });
    expect(sends.length).toBe(3);

    const [row] = await db
      .select({
        status: bulkEmailJobs.status,
        deliveredCount: bulkEmailJobs.deliveredCount,
        failedCount: bulkEmailJobs.failedCount,
        deliveredConstituentIds: bulkEmailJobs.deliveredConstituentIds,
        failedConstituentIds: bulkEmailJobs.failedConstituentIds,
      })
      .from(bulkEmailJobs)
      .where(eq(bulkEmailJobs.id, jobId));
    expect(row?.status).toBe("partial");
    expect(row?.deliveredCount).toBe(2);
    expect(row?.failedCount).toBe(1);
    expect(row?.failedConstituentIds).toEqual([constituentBId]);
    expect(row?.deliveredConstituentIds?.sort()).toEqual([constituentAId, constituentCId].sort());
  });

  it("skips recipients already in delivered_constituent_ids on retry (BullMQ retry idempotency)", async () => {
    // Simulates a BullMQ retry: the previous attempt delivered to Alice
    // and the worker process died before finalising. On retry, the
    // processor's filter `targetIds = constituent_ids \ delivered \
    // failed` must skip Alice and only attempt Bob.
    const jobId = await seedJob({
      status: "processing",
      constituentIds: [constituentAId, constituentBId],
      delivered: [constituentAId],
    });
    const { sender, sends } = recordingSender();

    const result = await processSendBulkEmail(
      makeMockJob({ orgId: ORG_ID, bulkEmailJobId: jobId }),
      { emailSender: sender },
    );

    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sends.map((s) => s.to)).toEqual(["bob.bulk@example.org"]);

    const [row] = await db
      .select({
        status: bulkEmailJobs.status,
        deliveredCount: bulkEmailJobs.deliveredCount,
        deliveredConstituentIds: bulkEmailJobs.deliveredConstituentIds,
      })
      .from(bulkEmailJobs)
      .where(eq(bulkEmailJobs.id, jobId));
    expect(row?.status).toBe("completed");
    expect(row?.deliveredCount).toBe(2);
    expect(row?.deliveredConstituentIds?.sort()).toEqual([constituentAId, constituentBId].sort());
  });

  it("does NOT re-fan-out when the row is already in a terminal state (duplicate-retry guard)", async () => {
    // A `completed` row should be left alone — re-running the worker
    // against the same job (Redis hand-off, BullMQ job-id collision) must
    // not send a second time.
    const jobId = await seedJob({
      status: "partial",
      constituentIds: [constituentAId, constituentBId],
      delivered: [constituentAId],
    });
    // Manually flip to a terminal state.
    await db
      .update(bulkEmailJobs)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(bulkEmailJobs.id, jobId));

    const { sender, sends } = recordingSender();

    const result = await processSendBulkEmail(
      makeMockJob({ orgId: ORG_ID, bulkEmailJobId: jobId }),
      { emailSender: sender },
    );

    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(sends).toEqual([]);

    const [row] = await db
      .select({ status: bulkEmailJobs.status, deliveredCount: bulkEmailJobs.deliveredCount })
      .from(bulkEmailJobs)
      .where(eq(bulkEmailJobs.id, jobId));
    expect(row?.status).toBe("completed");
    expect(row?.deliveredCount).toBe(1);
  });

  it("handles a missing bulk_email_jobs row gracefully (outbox/DB drift)", async () => {
    // The worker is best-effort: if the DB row vanished (manual cleanup,
    // GDPR cascade) the processor logs a warning and short-circuits
    // rather than throwing — which would trigger BullMQ retries against
    // a row that's never coming back.
    const { sender, sends } = recordingSender();
    const result = await processSendBulkEmail(
      makeMockJob({
        orgId: ORG_ID,
        bulkEmailJobId: "00000000-0000-0000-0000-000000000bad",
      }),
      { emailSender: sender },
    );
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(sends).toEqual([]);
  });
});
