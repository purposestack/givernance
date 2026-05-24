// #436 — finance.survey_send
/**
 * Hourly cron job — fans out survey invitations whose
 * `surveys.next_scheduled_at` is due.
 *
 * For each due survey:
 *  1. Resolve the cohort via `survey.cohort_rule` (a JSONB matcher of the
 *     shape `{ roles?: UserRole[]; orgIds?: string[]; excludeUserIds?:
 *     string[] }`). Cross-tenant: cohort resolution must see every
 *     tenant's users, scoped by their `org_id` and the rule predicate.
 *  2. For each user in the cohort, INSERT one `survey_invitations` row
 *     (idempotent: skipped if an active (non-deleted, non-dismissed,
 *     non-opened) invitation already exists for this (survey_id,
 *     user_id) pair).
 *  3. For channel='email' invitations, INSERT an outbox event of type
 *     `survey.invitation.send_email`. API agent #437 wires the email
 *     consumer; until then the event sits in the outbox as the audit
 *     trail of "we tried".
 *  4. Update `surveys.next_scheduled_at = NOW() + cadence_days days`
 *     for cyclical surveys; one-shot surveys (cadence_days IS NULL)
 *     are left with their `next_scheduled_at` in the past so they
 *     don't re-trigger.
 *
 * Gated by `admin.finance_dashboard` — no-op when flag is off (the
 * survey infrastructure ships dark with the dashboard).
 *
 * Cohort matcher (the MVP shape, intentionally tiny — extend in docs/31):
 *   { "roles": ["org_admin"], "orgIds": ["..."], "excludeUserIds": ["..."] }
 */

import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { SURVEY_EVENT_TYPES } from "@givernance/shared/jobs";
import {
  outboxEvents,
  surveyInvitations,
  surveys,
  tenants,
  users,
} from "@givernance/shared/schema";
import type { Job } from "bullmq";
import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { db } from "../lib/db.js";
import { isFlagEnabled } from "../lib/flags.js";
import { jobLogger } from "../lib/logger.js";

/** JSONB matcher shape for `surveys.cohort_rule`. */
export interface CohortRule {
  /** Match users with any of these roles. Empty/missing = no role filter. */
  roles?: ("org_admin" | "user" | "viewer")[];
  /** Restrict to these tenants. Missing = all non-archived/suspended tenants. */
  orgIds?: string[];
  /** Explicit excludes (e.g. users we've already onboarded into the survey). */
  excludeUserIds?: string[];
}

/**
 * Pure cohort resolver — exported for unit tests so the SQL composition is
 * exercised without booting Postgres. Returns the list of (userId, orgId,
 * email) tuples matching the rule.
 */
export async function resolveCohort(rule: CohortRule): Promise<
  {
    userId: string;
    orgId: string;
    email: string;
  }[]
> {
  // CROSS-TENANT INTENTIONAL: survey cohort spans every tenant matching
  // the predicate — that's the point of a platform-wide PMF/NPS sweep.
  // Owner-pool (`db`) is required; per-row org_id stays explicit on
  // every downstream write.
  const predicates = [isNull(users.deletedAt)];

  if (rule.roles && rule.roles.length > 0) {
    predicates.push(inArray(users.role, rule.roles));
  }
  if (rule.orgIds && rule.orgIds.length > 0) {
    predicates.push(inArray(users.orgId, rule.orgIds));
  } else {
    // Default: only members of active tenants. Provisional tenants
    // get surveyed too — they're our highest-signal PMF cohort.
    predicates.push(sql`${tenants.status} NOT IN ('archived', 'suspended')`);
  }
  if (rule.excludeUserIds && rule.excludeUserIds.length > 0) {
    predicates.push(not(inArray(users.id, rule.excludeUserIds)));
  }

  return db
    .select({ userId: users.id, orgId: users.orgId, email: users.email })
    .from(users)
    .innerJoin(tenants, eq(tenants.id, users.orgId))
    .where(and(...predicates));
}

interface SurveyRow {
  id: string;
  slug: string;
  cadenceDays: number | null;
  cohortRule: unknown;
  /** ISO `expires_at` for the next invitation batch. */
}

function inviteExpiresAt(now: Date, cadenceDays: number | null): Date {
  // One-shot surveys: 30-day expiry window.
  // Cyclical surveys: expiry equals the next cadence boundary so a recipient
  // who ignores it cleanly times out before the next one is sent.
  const windowDays = cadenceDays ?? 30;
  const expiry = new Date(now);
  expiry.setUTCDate(expiry.getUTCDate() + windowDays);
  return expiry;
}

export async function processSurveySend(job: Job): Promise<void> {
  const log = jobLogger({ jobId: job.id, tenantId: "system" });

  const flagOn = await isFlagEnabled(FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD);
  if (!flagOn) {
    log.info("admin.finance_dashboard flag is off, skipping survey send loop");
    return;
  }

  const now = new Date();

  // CROSS-TENANT INTENTIONAL: surveys is a platform-level table (no
  // org_id, no RLS). REVOKEd from givernance_app — owner-pool only.
  const due: SurveyRow[] = await db
    .select({
      id: surveys.id,
      slug: surveys.slug,
      cadenceDays: surveys.cadenceDays,
      cohortRule: surveys.cohortRule,
    })
    .from(surveys)
    .where(and(isNull(surveys.deletedAt), sql`${surveys.nextScheduledAt} <= ${now}`));

  log.info({ dueCount: due.length }, "survey send loop tick");

  for (const survey of due) {
    try {
      await sendInvitationsForSurvey(survey, now, log);
    } catch (err) {
      // Per-survey failures are logged but do not abort the sweep.
      // The next hourly tick retries (next_scheduled_at unchanged on
      // failure path).
      const message = err instanceof Error ? err.message : "Unknown error";
      log.error({ surveyId: survey.id, err: message }, "survey send failed");
    }
  }
}

async function sendInvitationsForSurvey(
  survey: SurveyRow,
  now: Date,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  const rule = (survey.cohortRule ?? {}) as CohortRule;
  const cohort = await resolveCohort(rule);
  const expiresAt = inviteExpiresAt(now, survey.cadenceDays);

  let invited = 0;
  let skipped = 0;

  for (const member of cohort) {
    // Idempotency: skip if an active invitation already exists for this
    // (survey, user) — "active" = not deleted, not opened, not
    // dismissed, and expiry in the future. A recipient who already
    // opened the previous invitation gets the next cycle's invitation
    // normally; one who ignored it does NOT get a duplicate.
    //
    // Explicit `eq(orgId, …)` on the lookup even though (survey,user)
    // already pins the tenant — defence-in-depth per CLAUDE.md.
    const [existing] = await db
      .select({ id: surveyInvitations.id })
      .from(surveyInvitations)
      .where(
        and(
          eq(surveyInvitations.surveyId, survey.id),
          eq(surveyInvitations.userId, member.userId),
          eq(surveyInvitations.orgId, member.orgId),
          isNull(surveyInvitations.deletedAt),
          isNull(surveyInvitations.openedAt),
          isNull(surveyInvitations.dismissedAt),
          sql`${surveyInvitations.expiresAt} > ${now}`,
        ),
      )
      .limit(1);

    if (existing) {
      skipped += 1;
      continue;
    }

    // Channel choice: email is the default for PMF/NPS sweeps (the
    // recipient may not be logged in within the window); in-app
    // surveys are emitted separately by the super-admin "Lancer
    // (in-app)" route (#437). The send loop here defaults to email.
    const channel = "email";

    // Owner-pool INSERT: scoped explicitly by org_id from the cohort
    // row — every row carries its tenant pointer.
    const [created] = await db
      .insert(surveyInvitations)
      .values({
        surveyId: survey.id,
        userId: member.userId,
        orgId: member.orgId,
        channel,
        expiresAt,
      })
      .returning({ id: surveyInvitations.id });

    if (!created) {
      // RETURNING swallowed by DB driver — shouldn't happen but
      // refuse to emit an outbox event we can't tie back.
      continue;
    }

    // Emit outbox event for the email send. Owner-pool insert; the
    // outbox row carries `tenantId` so the existing relay routes it
    // back to a tenant-scoped consumer (API agent #437 wires the
    // email-send handler).
    await db.insert(outboxEvents).values({
      tenantId: member.orgId,
      type: SURVEY_EVENT_TYPES.INVITATION_SEND_EMAIL,
      payload: {
        invitationId: created.id,
        surveyId: survey.id,
        surveySlug: survey.slug,
        userId: member.userId,
        email: member.email,
        expiresAt: expiresAt.toISOString(),
        source: "finance.survey_send",
      },
    });

    invited += 1;
  }

  // Reschedule cyclical surveys; leave one-shots in the past so they
  // don't re-trigger.
  if (survey.cadenceDays && survey.cadenceDays > 0) {
    const next = new Date(now);
    next.setUTCDate(next.getUTCDate() + survey.cadenceDays);
    await db
      .update(surveys)
      .set({ nextScheduledAt: next, updatedAt: new Date() })
      .where(eq(surveys.id, survey.id));
  } else {
    // One-shot: null out next_scheduled_at so the loop ignores it
    // going forward.
    await db
      .update(surveys)
      .set({ nextScheduledAt: null, updatedAt: new Date() })
      .where(eq(surveys.id, survey.id));
  }

  log.info(
    { surveyId: survey.id, surveySlug: survey.slug, invited, skipped, cohortSize: cohort.length },
    "survey send completed",
  );
}
