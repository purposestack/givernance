/**
 * Platform-admin invite email processor (issue #254 fix-commit 4 refactor).
 *
 * Handles `platform_admin.invited` outbox events. Same SEC-7 posture as
 * `team-invite-email.ts`: the raw token is NOT in the outbox payload —
 * we look it up here by invitation id, inside the SMTP relay's trust
 * boundary. Unknown / already-accepted invitations are terminal no-ops
 * so a stale event after a token rotation doesn't retry forever.
 *
 * Distinct from team-invite because:
 *   - The accept URL points at `/admin/platform-admins/accept` (super-admin
 *     onboarding), not `/invite/accept` (tenant member).
 *   - The email template emphasises "platform / Givernance staff", not
 *     "join <tenant>".
 *   - No tenant/inviter personalisation needed (operator emails are
 *     internal).
 */

import { invitations } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "../lib/db.js";
import { defaultEmailSender, type EmailSender } from "../lib/email.js";
import { ensureLocale, renderPlatformAdminInviteEmail } from "../lib/email-templates.js";

export interface PlatformAdminInviteEmailJobPayload {
  invitationId: string;
  /** BCP-47 — resolved at enqueue time. */
  locale: string;
}

export interface PlatformAdminInviteEmailDeps {
  sender?: EmailSender;
}

export async function processPlatformAdminInviteEmail(
  payload: PlatformAdminInviteEmailJobPayload,
  deps: PlatformAdminInviteEmailDeps = {},
): Promise<{ sent: boolean; reason?: "not_found" | "already_accepted" }> {
  const sender = deps.sender ?? defaultEmailSender;

  const [row] = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      firstName: invitations.firstName,
      lastName: invitations.lastName,
      token: invitations.token,
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
    })
    .from(invitations)
    .where(
      and(
        eq(invitations.id, payload.invitationId),
        eq(invitations.purpose, "platform_admin_invite"),
      ),
    )
    .limit(1);

  if (!row) return { sent: false, reason: "not_found" };
  if (row.acceptedAt) return { sent: false, reason: "already_accepted" };

  const acceptUrl = `${env.APP_URL.replace(
    /\/$/,
    "",
  )}/admin/platform-admins/accept?token=${encodeURIComponent(row.token)}`;
  const rendered = renderPlatformAdminInviteEmail({
    inviteeFirstName: row.firstName ?? "",
    acceptUrl,
    expiresAt: row.expiresAt,
    locale: ensureLocale(payload.locale),
  });

  await sender.send({
    to: row.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return { sent: true };
}
