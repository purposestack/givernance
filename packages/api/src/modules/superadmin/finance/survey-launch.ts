// #437 — POST /v1/superadmin/surveys/:slug/launch service.
//
// Idempotent (UUID `Idempotency-Key` header) and rate-limited (≤1
// successful launch per (survey, channel) per 24h). Replays the
// cached row on key collision; emits 429 + `Retry-After` on cooldown.

import { SURVEY_EVENT_TYPES } from "@givernance/shared/jobs";
import {
  outboxEvents,
  surveyInvitations,
  surveyLaunches,
  surveys,
} from "@givernance/shared/schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { systemDb } from "../../../lib/db.js";
import { resolveCohort } from "./survey-cohort.js";

/**
 * Cooldown is differentiated by channel (issue #444 follow-up):
 *
 * - `email` keeps the 24h lock. The outbox relay commits the SMTP
 *   send minutes after the row lands, so a Tuesday re-launch on
 *   Monday's PMF would dump a second email into every non-responder's
 *   inbox — bad first impression, hard to walk back.
 *
 * - `in_app` runs with no cooldown. The fan-out's existing-invitation
 *   guard (see below — `existingInvite` check on opened/dismissed/
 *   expires) structurally prevents duplicate modals: a double-click
 *   produces 0 new invitations, not two pops. The `@fastify/rate-limit`
 *   cap on the route (10/min/IP per PR #441) handles abuse. So 24h
 *   would punish a legitimate operator re-attempt for no privacy
 *   benefit.
 *
 * Combined with the `recipient_count > 0` predicate on the cooldown
 * SELECT (below), a launch that resolved to 0 new invitees doesn't
 * lock the (survey, channel) at all — fixing the staging gotcha where
 * a freshly-seeded environment burned 24h on the first click.
 */
const COOLDOWN_MS_BY_CHANNEL: Record<"email" | "in_app", number> = {
  email: 24 * 60 * 60 * 1000,
  in_app: 0,
};
const INVITATION_EXPIRY_DAYS = 30;

export type LaunchError =
  | { kind: "survey_not_found" }
  | { kind: "rate_limited"; retryAfterSeconds: number }
  | { kind: "idempotency_key_conflict" };

export interface LaunchResult {
  launchId: string;
  surveyId: string;
  channel: "email" | "in_app";
  recipientCount: number;
  launchedAt: Date;
  replayed: boolean;
}

/**
 * Resolve a survey row by slug (excludes soft-deleted). Platform-level
 * read — no org_id involved, runs through systemDb.
 */
async function findSurveyBySlug(slug: string) {
  const [row] = await systemDb
    .select({
      id: surveys.id,
      slug: surveys.slug,
      cadenceDays: surveys.cadenceDays,
      cohortRule: surveys.cohortRule,
    })
    .from(surveys)
    .where(and(eq(surveys.slug, slug), isNull(surveys.deletedAt)))
    .limit(1);
  return row;
}

export async function launchSurvey(input: {
  slug: string;
  channel: "email" | "in_app";
  idempotencyKey: string;
  launchedByPlatformAdminId: string;
  now?: Date;
}): Promise<LaunchResult | LaunchError> {
  const now = input.now ?? new Date();

  const survey = await findSurveyBySlug(input.slug);
  if (!survey) {
    return { kind: "survey_not_found" };
  }

  // Idempotency: if the key was used before, return the cached row.
  const [existing] = await systemDb
    .select({
      id: surveyLaunches.id,
      surveyId: surveyLaunches.surveyId,
      channel: surveyLaunches.channel,
      recipientCount: surveyLaunches.recipientCount,
      launchedAt: surveyLaunches.launchedAt,
    })
    .from(surveyLaunches)
    .where(eq(surveyLaunches.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (existing) {
    // RFC 7240-ish / Stripe-style idempotency: same key + different request
    // body must fail closed with 409 — otherwise an attacker (or an honest
    // bug) could reuse a captured key to replay a stale cached response for
    // a *different* (survey, channel) pair. The (surveyId, channel) tuple
    // IS the request body for this endpoint.
    if (existing.surveyId !== survey.id || existing.channel !== input.channel) {
      return { kind: "idempotency_key_conflict" };
    }
    return {
      launchId: existing.id,
      surveyId: existing.surveyId,
      channel: existing.channel as "email" | "in_app",
      recipientCount: existing.recipientCount,
      launchedAt: existing.launchedAt,
      replayed: true,
    };
  }

  // Cooldown: refuse a fresh launch if any prior launch for the same
  // (survey, channel) within the channel's lock window actually
  // produced at least one invitation. The `recipient_count > 0` guard
  // matters: a launch that resolved to 0 new invitees (whole cohort
  // already invited) cost the system nothing and must not lock the
  // operator out for 24h — that was the staging gotcha that drove
  // this follow-up. The `in_app` channel runs with cooldownMs=0 so
  // this whole branch short-circuits past it.
  const cooldownMs = COOLDOWN_MS_BY_CHANNEL[input.channel];
  if (cooldownMs > 0) {
    const cooldownThreshold = new Date(now.getTime() - cooldownMs);
    const [recent] = await systemDb
      .select({ launchedAt: surveyLaunches.launchedAt })
      .from(surveyLaunches)
      .where(
        and(
          eq(surveyLaunches.surveyId, survey.id),
          eq(surveyLaunches.channel, input.channel),
          gt(surveyLaunches.launchedAt, cooldownThreshold),
          gt(surveyLaunches.recipientCount, 0),
        ),
      )
      .orderBy(sql`${surveyLaunches.launchedAt} DESC`)
      .limit(1);

    if (recent) {
      const retryAt = new Date(recent.launchedAt.getTime() + cooldownMs);
      const retryAfterSeconds = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 1000));
      return { kind: "rate_limited", retryAfterSeconds };
    }
  }

  // Resolve cohort. The worker uses the same resolver for the scheduled
  // loop; here we run it synchronously for the on-demand fan-out.
  const rule = (survey.cohortRule ?? {}) as Parameters<typeof resolveCohort>[0];
  const cohort = await resolveCohort(rule);

  const expiresAt = new Date(now);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + INVITATION_EXPIRY_DAYS);

  let invitedCount = 0;

  // Fan-out: one invitation per cohort member that doesn't already have
  // an active invitation. Idempotency mirrors the worker (#436).
  for (const member of cohort) {
    const [existingInvite] = await systemDb
      .select({ id: surveyInvitations.id })
      .from(surveyInvitations)
      .where(
        and(
          eq(surveyInvitations.surveyId, survey.id),
          eq(surveyInvitations.userId, member.userId),
          // Defence-in-depth eq(orgId) per CLAUDE.md even though the
          // (survey, user) pair already pins the tenant.
          eq(surveyInvitations.orgId, member.orgId),
          isNull(surveyInvitations.deletedAt),
          isNull(surveyInvitations.openedAt),
          isNull(surveyInvitations.dismissedAt),
          gt(surveyInvitations.expiresAt, now),
        ),
      )
      .limit(1);
    if (existingInvite) continue;

    const [invite] = await systemDb
      .insert(surveyInvitations)
      .values({
        surveyId: survey.id,
        userId: member.userId,
        orgId: member.orgId,
        channel: input.channel,
        expiresAt,
      })
      .returning({ id: surveyInvitations.id });
    if (!invite) continue;

    if (input.channel === "email") {
      await systemDb.insert(outboxEvents).values({
        tenantId: member.orgId,
        type: SURVEY_EVENT_TYPES.INVITATION_SEND_EMAIL,
        payload: {
          invitationId: invite.id,
          surveyId: survey.id,
          surveySlug: survey.slug,
          userId: member.userId,
          email: member.email,
          expiresAt: expiresAt.toISOString(),
          source: "superadmin.launch",
        },
      });
    }
    invitedCount += 1;
  }

  // Persist the launch row. ON CONFLICT (idempotency_key) DO NOTHING so
  // a concurrent duplicate POST is safe; the second caller falls
  // through to the cached read on the next attempt.
  const [launch] = await systemDb
    .insert(surveyLaunches)
    .values({
      surveyId: survey.id,
      channel: input.channel,
      idempotencyKey: input.idempotencyKey,
      launchedBy: input.launchedByPlatformAdminId,
      recipientCount: invitedCount,
      launchedAt: now,
    })
    .onConflictDoNothing({ target: surveyLaunches.idempotencyKey })
    .returning({
      id: surveyLaunches.id,
      surveyId: surveyLaunches.surveyId,
      channel: surveyLaunches.channel,
      recipientCount: surveyLaunches.recipientCount,
      launchedAt: surveyLaunches.launchedAt,
    });

  if (!launch) {
    // Lost the race — re-read the conflicting row.
    const [committed] = await systemDb
      .select({
        id: surveyLaunches.id,
        surveyId: surveyLaunches.surveyId,
        channel: surveyLaunches.channel,
        recipientCount: surveyLaunches.recipientCount,
        launchedAt: surveyLaunches.launchedAt,
      })
      .from(surveyLaunches)
      .where(eq(surveyLaunches.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!committed) {
      throw new Error("survey launch: conflict resolution lost the row");
    }
    return {
      launchId: committed.id,
      surveyId: committed.surveyId,
      channel: committed.channel as "email" | "in_app",
      recipientCount: committed.recipientCount,
      launchedAt: committed.launchedAt,
      replayed: true,
    };
  }

  // Nudge the worker to re-evaluate this survey on the next tick by
  // advancing next_scheduled_at to NOW; safe to do even for one-shot
  // surveys (cadence_days IS NULL) — the worker leaves them past-due
  // after fan-out.
  await systemDb
    .update(surveys)
    .set({ nextScheduledAt: now, updatedAt: now })
    .where(eq(surveys.id, survey.id));

  return {
    launchId: launch.id,
    surveyId: launch.surveyId,
    channel: launch.channel as "email" | "in_app",
    recipientCount: launch.recipientCount,
    launchedAt: launch.launchedAt,
    replayed: false,
  };
}
