/**
 * Shared lookup-and-rotate helper for `POST /v1/public/signup/resend`.
 *
 * Hoisted to `@givernance/shared` so the API package (used by integration
 * tests) and the worker package (the production handler invoked from
 * BullMQ) operate on a single implementation. The previous arrangement —
 * api/src/modules/signup/service.ts:resendVerification +
 * worker/src/processors/signup-resend.ts:processSignupResendPayload —
 * carried two ~50-line copies of the same SELECT + UPDATE + outbox INSERT
 * with no shared source, and a drift in recovery predicates / locale
 * fallback / FOR-UPDATE choice would have only surfaced after a real
 * customer hit the half-state.
 *
 * Matches three recoverable states (same as the original service-level
 * code, see signup/service.ts module header for the full history):
 *   1. Pending verify (tenant=provisional, acceptedAt=null).
 *   2. No Keycloak credential (active tenant, users.keycloak_id IS NULL).
 *   3. No Keycloak Organization (active tenant, keycloak_org_id IS NULL).
 *
 * Cases (2) and (3) clear `acceptedAt` so the next verify can complete the
 * missing bind step. Everything else silently no-ops — the route never
 * surfaces the matched/no-match bit, so this isn't an enumeration oracle.
 */

import {
  invitations,
  type OutboxMetadata,
  outboxEvents,
  tenants,
  users,
} from "@givernance/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { APP_DEFAULT_LOCALE, isSupportedLocale, type Locale } from "../i18n/locales";

const VERIFICATION_TTL_HOURS = 24;

/** Pino-shaped log methods. Both api + worker pass real pino loggers. */
interface MinimalLogger {
  info(fields: Record<string, unknown>, msg?: string): void;
}

export type ResendSignupResult =
  | { matched: true; tenantId: string; status: string }
  | { matched: false };

// biome-ignore lint/suspicious/noExplicitAny: drizzle's generic schema parameter — we don't constrain it because both api and worker package the same `@givernance/shared/schema` instance and any narrower type binds us to one package's type-resolution path.
type Db = NodePgDatabase<any>;

/**
 * Look up a resend candidate by email and, if found, rotate the
 * invitation token + insert a `tenant.signup_verification_resent` outbox
 * event for the worker to pick up.
 *
 * Caller responsibilities:
 *  - Pass a `db` that's allowed to read across tenants (system / owner
 *    role). The candidate SELECT joins `users` + `tenants` + `invitations`
 *    with no org context; the unauthenticated route has none and the
 *    unguessable invitation token is the security boundary.
 *  - Generate `newToken` via `randomUUID()`. Passing the token in keeps
 *    `@givernance/shared` free of `node:crypto` so the web bundle can
 *    import the package without breaking ADR-013.
 *  - Treat `{ matched: false }` as a silent no-op (no log line worth
 *    pinning beyond the optional debug info — surfaces upstream).
 */
export async function resendSignupVerification(
  db: Db,
  email: string,
  newToken: string,
  log?: MinimalLogger,
  /** W3C trace-context for the outbox insert (issue #55) — callers with no trace pass null. */
  metadata?: OutboxMetadata | null,
): Promise<ResendSignupResult> {
  const normalised = email.trim().toLowerCase();

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
    log?.info({ event: "signup.resend", matched: false }, "resend silent no-match");
    return { matched: false };
  }

  const row = rows[0];
  if (!row) return { matched: false };

  const localeForResend: Locale = isSupportedLocale(row.defaultLocale)
    ? row.defaultLocale
    : APP_DEFAULT_LOCALE;

  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    // Half-provisioned rows have `acceptedAt` set from the prior verify;
    // clearing it lets verifySignup's invitation-validity guard accept the
    // fresh token. The pre-existing audit_logs row preserves the original
    // acceptance event, so this isn't a history rewrite.
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
      metadata: metadata ?? null,
    });
  });

  log?.info(
    { event: "signup.resend", matched: true, tenantId: row.tenantId, status: row.status },
    "resend rotated invitation token",
  );

  return { matched: true, tenantId: row.tenantId, status: row.status };
}
