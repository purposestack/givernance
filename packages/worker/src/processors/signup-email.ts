/**
 * Signup verification email processor (issue #109 follow-up).
 *
 * Handles `tenant.signup_verification_requested` and
 * `tenant.signup_verification_resent` domain events from the outbox.
 *
 * The raw verification token is intentionally NOT in the outbox payload
 * (SEC-7 in signup/service.ts) — we look it up here by invitation id,
 * inside the same trust boundary as the SMTP relay.
 */

import { invitations, tenants } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "../lib/db.js";
import { defaultEmailSender, type EmailSender } from "../lib/email.js";
import { renderSignupVerifyEmail } from "../lib/email-templates.js";

export interface SignupEmailJobPayload {
  tenantId: string;
  invitationId: string;
  expiresAt: string;
  /** Optional ISO-3166-1 alpha-2 — drives EN/FR template selection. */
  country?: string;
}

export interface SignupEmailDeps {
  sender?: EmailSender;
  now?: () => Date;
}

/**
 * Look up the invitation + tenant, render the email, and dispatch it.
 *
 * Throws on any step — BullMQ's retry/backoff will catch transient SMTP
 * failures. Unknown / already-accepted invitations are treated as a no-op
 * success: the outbox event may arrive after `resend` rotated the token
 * (the old token is gone and we don't want to retry forever).
 */
export async function processSignupVerificationEmail(
  payload: SignupEmailJobPayload,
  deps: SignupEmailDeps = {},
): Promise<{ sent: boolean; reason?: "not_found" | "already_accepted" }> {
  const sender = deps.sender ?? defaultEmailSender;

  const [row] = await db
    .select({
      invitationId: invitations.id,
      email: invitations.email,
      token: invitations.token,
      acceptedAt: invitations.acceptedAt,
      tenantName: tenants.name,
    })
    .from(invitations)
    .innerJoin(tenants, eq(invitations.orgId, tenants.id))
    .where(
      and(
        eq(invitations.id, payload.invitationId),
        eq(invitations.orgId, payload.tenantId),
        eq(invitations.purpose, "signup_verification"),
      ),
    )
    .limit(1);

  if (!row) {
    return { sent: false, reason: "not_found" };
  }
  if (row.acceptedAt) {
    return { sent: false, reason: "already_accepted" };
  }

  const verifyUrl = `${env.APP_URL}/signup/verify?token=${encodeURIComponent(row.token)}`;
  const rendered = renderSignupVerifyEmail({
    tenantName: row.tenantName,
    verifyUrl,
    expiresAt: new Date(payload.expiresAt),
    country: payload.country,
  });

  await sender.send({
    to: row.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return { sent: true };
}
