/**
 * Team-invite email processor (issue #145).
 *
 * Handles three outbox event types:
 *  - `invitation.created` — first delivery after an org_admin clicks "Invite".
 *  - `invitation.resent`  — token was rotated; old link is now dead.
 *  - `tenant.first_admin_invited` — super-admin seeding path; same template,
 *     different copy because the inviter row may not exist yet.
 *
 * Pattern is identical to `processSignupVerificationEmail`: the raw token
 * is intentionally NOT in the outbox payload (SEC-7 in the API service) —
 * we look it up here by invitation id, inside the same trust boundary as
 * the SMTP relay. Unknown / already-accepted invitations are terminal
 * no-ops so a stale event after a token rotation doesn't retry forever.
 */

import { invitations, tenants, users } from "@givernance/shared/schema";
import { and, eq } from "drizzle-orm";
import { env } from "../env.js";
import { db } from "../lib/db.js";
import { defaultEmailSender, type EmailSender } from "../lib/email.js";
import { renderTeamInviteEmail } from "../lib/email-templates.js";

export interface TeamInviteEmailJobPayload {
  tenantId: string;
  invitationId: string;
  /** UUID of the inviting `users` row, or null when seeded by super-admin. */
  inviterUserId?: string | null;
  /** ISO-3166-1 alpha-2 — drives EN/FR template selection. Optional. */
  country?: string;
}

export interface TeamInviteEmailDeps {
  sender?: EmailSender;
}

export async function processTeamInviteEmail(
  payload: TeamInviteEmailJobPayload,
  deps: TeamInviteEmailDeps = {},
): Promise<{ sent: boolean; reason?: "not_found" | "already_accepted" }> {
  const sender = deps.sender ?? defaultEmailSender;

  const [row] = await db
    .select({
      invitationId: invitations.id,
      email: invitations.email,
      role: invitations.role,
      token: invitations.token,
      acceptedAt: invitations.acceptedAt,
      expiresAt: invitations.expiresAt,
      tenantName: tenants.name,
    })
    .from(invitations)
    .innerJoin(tenants, eq(invitations.orgId, tenants.id))
    .where(
      and(
        eq(invitations.id, payload.invitationId),
        eq(invitations.orgId, payload.tenantId),
        eq(invitations.purpose, "team_invite"),
      ),
    )
    .limit(1);

  if (!row) return { sent: false, reason: "not_found" };
  if (row.acceptedAt) return { sent: false, reason: "already_accepted" };

  // Resolve the inviter's display name — purely for personalisation. We
  // run this without tenant context because the worker has no JWT and the
  // events queue is itself the tenant boundary; `users` is FORCE RLS but
  // the worker process uses the system role. A null result is fine —
  // `renderTeamInviteEmail` falls back to "A colleague".
  let inviterName: string | null = null;
  if (payload.inviterUserId) {
    const [u] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, payload.inviterUserId))
      .limit(1);
    if (u) inviterName = `${u.firstName} ${u.lastName}`.trim() || null;
  }

  const acceptUrl = `${env.APP_URL}/invite/accept?token=${encodeURIComponent(row.token)}`;
  const rendered = renderTeamInviteEmail({
    tenantName: row.tenantName,
    inviterName,
    role: row.role,
    acceptUrl,
    expiresAt: row.expiresAt,
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
