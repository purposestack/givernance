/**
 * Signup-resend processor (F3, follow-up to ADR-016 §8 anti-enumeration).
 *
 * The public `POST /v1/public/signup/resend` endpoint enqueues this job and
 * returns 204 immediately — both for matching and non-matching emails — so
 * an attacker cannot tell "email belongs to a pending tenant" from "no
 * match" by timing the HTTP response. This processor runs the actual
 * lookup-and-rotate logic asynchronously.
 *
 * Mirrors the recovery semantics of `signup.service.resendVerification`:
 * matches three half-states (pending verify, no Keycloak credential, no
 * Keycloak Organization) and silently no-ops on everything else.
 *
 * Owner role: the matching SELECT spans tenants and the
 * `signup_verification` invitation row joins `users` + `tenants` with no
 * org context (the request is unauthenticated, the unguessable invitation
 * token is the boundary). The app role would have RLS filter the join to
 * zero rows.
 */

import { randomUUID } from "node:crypto";
import { APP_DEFAULT_LOCALE, isSupportedLocale, type Locale } from "@givernance/shared/i18n";
import { invitations, outboxEvents, tenants, users } from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import { jobLogger } from "../lib/logger.js";

const VERIFICATION_TTL_HOURS = 24;

export interface SignupResendJobPayload {
  email: string;
}

export type SignupResendResult =
  | { matched: true; tenantId: string }
  | { matched: false; reason: "no_match" };

/**
 * Direct callable for tests — avoids spinning up the BullMQ worker.
 *
 * Behaviour is identical to the legacy synchronous `resendVerification`
 * service in the API package, with the additional contract that the caller
 * is OK with "no match" being a silent no-op (the HTTP route does not
 * surface the matched/not-matched bit to the client).
 */
export async function processSignupResendPayload(
  payload: SignupResendJobPayload,
  log = jobLogger({ tenantId: "system" }),
): Promise<SignupResendResult> {
  const normalised = payload.email.trim().toLowerCase();

  const rows = await db
    .select({
      tenantId: tenants.id,
      status: tenants.status,
      defaultLocale: tenants.defaultLocale,
      invitationId: invitations.id,
    })
    .from(invitations)
    .innerJoin(tenants, eq(invitations.orgId, tenants.id))
    .leftJoin(
      users,
      and(
        eq(users.orgId, invitations.orgId),
        sql`lower(${users.email}) = lower(${invitations.email})`,
      ),
    )
    .where(
      and(
        eq(invitations.email, normalised),
        eq(invitations.purpose, "signup_verification"),
        eq(tenants.createdVia, "self_serve"),
        sql`(
          (${tenants.status} = 'provisional' AND ${invitations.acceptedAt} IS NULL)
          OR
          (${tenants.status} = 'active'
            AND (${users.keycloakId} IS NULL OR ${tenants.keycloakOrgId} IS NULL))
        )`,
      ),
    )
    .orderBy(sql`${invitations.createdAt} DESC`)
    .limit(1);

  if (rows.length === 0) {
    log.info({ event: "signup.resend", matched: false }, "resend silent no-match");
    return { matched: false, reason: "no_match" };
  }

  const row = rows[0];
  if (!row) {
    return { matched: false, reason: "no_match" };
  }

  const localeForResend: Locale = isSupportedLocale(row.defaultLocale)
    ? row.defaultLocale
    : APP_DEFAULT_LOCALE;

  const newToken = randomUUID();
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.current_organization_id', ${row.tenantId}, true)`);

    await tx
      .update(invitations)
      .set({ token: newToken, expiresAt, acceptedAt: null })
      .where(eq(invitations.id, row.invitationId));

    await tx.insert(outboxEvents).values({
      tenantId: row.tenantId,
      type: "tenant.signup_verification_resent",
      payload: {
        tenantId: row.tenantId,
        invitationId: row.invitationId,
        expiresAt: expiresAt.toISOString(),
        locale: localeForResend,
      },
    });
  });

  log.info(
    { event: "signup.resend", matched: true, tenantId: row.tenantId, status: row.status },
    "resend rotated invitation token",
  );

  return { matched: true, tenantId: row.tenantId };
}

/** BullMQ processor wrapper. */
export async function processSignupResend(job: Job<SignupResendJobPayload>): Promise<void> {
  const log = jobLogger({ jobId: job.id, tenantId: "system" });
  await processSignupResendPayload(job.data, log);
}
