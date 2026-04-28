/**
 * Unit coverage for the Resend backend (issue #190).
 *
 * The Mailpit / nodemailer path is exercised end-to-end by the existing
 * `signup-email.test.ts` and `team-invite-email.test.ts` integration tests
 * (they inject a mock `EmailSender` so they don't depend on a live SMTP),
 * so this file only locks down the Resend-specific behaviour:
 *
 *   - Forwards `from / to / subject / html / text` verbatim to the SDK.
 *   - Re-throws when the SDK returns `{ error }` so BullMQ counts the
 *     job as failed and retries with backoff.
 */

import type { Resend } from "resend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResendSender } from "./email.js";
import { logger } from "./logger.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface MockResendClient {
  emails: {
    send: ReturnType<typeof vi.fn>;
  };
}

function makeClient(result: {
  data?: { id: string } | null;
  error?: { name: string; message: string } | null;
}): MockResendClient {
  return {
    emails: {
      send: vi.fn().mockResolvedValue(result),
    },
  };
}

describe("createResendSender", () => {
  it("forwards from/to/subject/html/text to the Resend client", async () => {
    // `env.EMAIL_FROM` is frozen at module init by the TypeBox validator
    // (see env.ts), so we read the resolved value once and assert against
    // it rather than trying to override at test time. The point of this
    // assertion is that the sender does not drop or rewrite any of the
    // five fields on its way to the SDK.
    const { resolveEmailFrom } = await import("../env.js");
    const expectedFrom = resolveEmailFrom();
    const client = makeClient({ data: { id: "msg-abc-123" }, error: null });
    const sender = createResendSender(client as unknown as Resend);

    await sender.send({
      to: "donor@example.org",
      subject: "Welcome",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(client.emails.send).toHaveBeenCalledOnce();
    expect(client.emails.send).toHaveBeenCalledWith({
      from: expectedFrom,
      to: "donor@example.org",
      subject: "Welcome",
      html: "<p>hi</p>",
      text: "hi",
    });
  });

  it("re-throws when the Resend SDK returns an error so BullMQ retries", async () => {
    const client = makeClient({
      data: null,
      error: { name: "validation_error", message: "Recipient is invalid" },
    });
    const sender = createResendSender(client as unknown as Resend);

    await expect(sender.send({ to: "bad@", subject: "x", html: "x", text: "x" })).rejects.toThrow(
      /validation_error.*Recipient is invalid/,
    );
  });

  it("logs the provider message id at info level on success", async () => {
    const client = makeClient({ data: { id: "msg-xyz-789" }, error: null });
    const sender = createResendSender(client as unknown as Resend);
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    await sender.send({
      to: "donor@example.org",
      subject: "Welcome",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(infoSpy).toHaveBeenCalledOnce();
    expect(infoSpy).toHaveBeenCalledWith({ providerMsgId: "msg-xyz-789" }, "resend.email.sent");
  });
});
