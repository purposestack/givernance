/**
 * SMTP transport + sendEmail helper for the worker (issue #109 follow-up).
 *
 * Wraps nodemailer so processors don't need to know about the transport.
 * In local dev the default config points at Mailpit (SMTP 1025, no auth,
 * no TLS); in production the operator provides real SMTP credentials via
 * SMTP_USER/SMTP_PASS. If no credentials are provided, auth is omitted so
 * Mailpit (which rejects AUTH entirely) works out of the box.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env.js";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<void>;
}

let cached: Transporter | undefined;

function transporter(): Transporter {
  if (cached) return cached;
  const auth =
    env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined;
  cached = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // STARTTLS is auto-negotiated when supported; Mailpit disables it.
    secure: env.SMTP_PORT === 465,
    auth,
  });
  return cached;
}

export const defaultEmailSender: EmailSender = {
  async send({ to, subject, html, text }) {
    await transporter().sendMail({
      from: env.SMTP_FROM,
      to,
      subject,
      html,
      text,
    });
  },
};
