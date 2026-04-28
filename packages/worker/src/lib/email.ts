/**
 * Email transport for the worker (issue #109 + issue #190).
 *
 * Two backends sit behind the same `EmailSender` interface so processors
 * never branch on provider:
 *
 *   - `mailpit` (default) — `nodemailer` SMTP. Local dev points at the
 *     Mailpit container (port 1025, no auth, no TLS); a host operator can
 *     also point it at any SMTP relay via `SMTP_HOST/PORT/USER/PASS`.
 *   - `resend`             — Resend HTTP API. Used on staging/prod per
 *     `docs/05-integration-migration.md` §3.1. Requires `RESEND_API_KEY`.
 *
 * The selection happens at first send (lazy) so test code that overrides
 * env (e.g. `vi.stubEnv("EMAIL_PROVIDER", "resend")`) doesn't have to
 * reload the module.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { Resend } from "resend";
import { env, resolveEmailFrom } from "../env.js";
import { logger } from "./logger.js";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<void>;
}

let cachedTransporter: Transporter | undefined;

function smtpTransporter(): Transporter {
  if (cachedTransporter) return cachedTransporter;
  const auth =
    env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined;
  cachedTransporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // STARTTLS is auto-negotiated when supported; Mailpit disables it.
    secure: env.SMTP_PORT === 465,
    auth,
  });
  return cachedTransporter;
}

const mailpitSender: EmailSender = {
  async send({ to, subject, html, text }) {
    await smtpTransporter().sendMail({
      from: resolveEmailFrom(),
      to,
      subject,
      html,
      text,
    });
  },
};

let cachedResendClient: Resend | undefined;

function resendClient(): Resend {
  if (cachedResendClient) return cachedResendClient;
  if (!env.RESEND_API_KEY) {
    // Surfaced at first send rather than at boot so the worker can still
    // boot and process non-email queues if Resend is misconfigured. The
    // BullMQ retry policy will surface the failure as a job failure.
    throw new Error("EMAIL_PROVIDER=resend but RESEND_API_KEY is not set — cannot send email.");
  }
  cachedResendClient = new Resend(env.RESEND_API_KEY);
  return cachedResendClient;
}

export function createResendSender(client: Resend = resendClient()): EmailSender {
  return {
    async send({ to, subject, html, text }) {
      const { data, error } = await client.emails.send({
        from: resolveEmailFrom(),
        to,
        subject,
        html,
        text,
      });
      if (error) {
        // Resend's SDK returns `{ data, error }` rather than throwing;
        // re-throw so BullMQ counts the job as failed and retries with
        // backoff like the SMTP path.
        throw new Error(`Resend send failed: ${error.name} — ${error.message}`);
      }
      // Surface the message id so support can correlate to the Resend
      // dashboard. Stays at info-level (no PII — recipient hashing is
      // out of scope here; that lands with the outbox/webhook
      // reconciliation in a follow-up).
      logger.info({ providerMsgId: data?.id ?? null }, "resend.email.sent");
    },
  };
}

let cachedSender: EmailSender | undefined;

/**
 * Lazily resolves the configured backend on first call. Cached so each
 * worker process keeps a single nodemailer transport / Resend client.
 */
export const defaultEmailSender: EmailSender = {
  async send(input) {
    if (!cachedSender) {
      cachedSender = env.EMAIL_PROVIDER === "resend" ? createResendSender() : mailpitSender;
    }
    return cachedSender.send(input);
  },
};
