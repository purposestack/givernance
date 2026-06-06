// #444 — Tenant-user endpoints powering the in-app survey delivery
// path. Splits cleanly from `survey-respond.ts` because it serves
// reads (list pending) + a state transition (dismiss) that don't
// touch `survey_responses`.
//
// Privacy posture: every query carries an explicit `eq(userId, …)` +
// `eq(orgId, …)` per CLAUDE.md "RLS is the safety net, never the
// contract". A leaked invitationId pointing at a different (user,
// tenant) returns 404, never 403 — no enumeration.
//
// DB pool: `systemDb` (BYPASSRLS owner pool). The join with the
// platform-level `surveys` table is the reason — migration 0071
// REVOKEs ALL on `surveys` from `givernance_app`, so the tenant pool
// would 500 on the join. Sibling services (`survey-launch.ts`,
// `survey-schedule.ts`) make the same choice for the same reason.
// The explicit eq(userId)+eq(orgId) above is the cross-tenant
// isolation that RLS would otherwise enforce.

import { surveyInvitations, surveyResponses, surveys } from "@givernance/shared/schema";
import { and, desc, eq, gt, inArray, isNull, notExists } from "drizzle-orm";
import { systemDb } from "../../../lib/db.js";

/**
 * `kind` is restricted to the three deliverable kinds (PMF / NPS /
 * CSAT). `custom` surveys exist in the schema but the modal has no
 * renderer for them — including them would surface a dead-end dialog
 * with no input + a permanently-disabled Submit. They're filtered out
 * at the SQL layer so the API response shape matches what the modal
 * can actually serve.
 */
export type PendingSurveyKind = "pmf" | "nps" | "csat";

export interface PendingInvitation {
  invitationId: string;
  surveyId: string;
  surveyKind: PendingSurveyKind;
  questionFr: string;
  questionEn: string;
  invitedAt: Date;
  expiresAt: Date;
}

export type DismissError = { kind: "invitation_not_found" };

export interface DismissResult {
  invitationId: string;
  dismissedAt: Date;
}

/**
 * List the current user's actionable survey invitations — both
 * channels.
 *
 * The `channel` column records HOW the invite was delivered (email
 * via SMTP or in_app via this modal), NOT how the response must be
 * collected. Once the user lands on /dashboard (whether via the
 * email magic-link or a normal login), the modal is the unified
 * response surface for both channels. Filtering to in_app only
 * would orphan every email recipient who clicks the CTA — they'd
 * land logged-in with no visible survey.
 *
 * The `surveys` join is platform-level (REVOKE'd from
 * `givernance_app`), which is why we use `systemDb` here.
 */
export async function listPendingInvitations(input: {
  userId: string;
  orgId: string;
  now?: Date;
}): Promise<PendingInvitation[]> {
  const now = input.now ?? new Date();
  const rows = await systemDb
    .select({
      invitationId: surveyInvitations.id,
      surveyId: surveys.id,
      surveyKind: surveys.kind,
      questionFr: surveys.questionFr,
      questionEn: surveys.questionEn,
      invitedAt: surveyInvitations.invitedAt,
      expiresAt: surveyInvitations.expiresAt,
    })
    .from(surveyInvitations)
    .innerJoin(surveys, eq(surveys.id, surveyInvitations.surveyId))
    .where(
      and(
        eq(surveyInvitations.userId, input.userId),
        eq(surveyInvitations.orgId, input.orgId),
        isNull(surveyInvitations.openedAt),
        isNull(surveyInvitations.dismissedAt),
        isNull(surveyInvitations.deletedAt),
        gt(surveyInvitations.expiresAt, now),
        // Authoritative "done" signal: an invitation with a (live) response is
        // never pending, regardless of `opened_at`. `opened_at IS NULL` above
        // is a softer UX gate (the respond + dismiss flows both set it), but
        // it can drift from reality — any path that records a response without
        // also stamping `opened_at` (a seed fixture, a partial write, manual
        // SQL) would otherwise resurface an already-answered survey at login
        // and loop the user into a 409 on re-submit. Gating on the response's
        // existence makes `pending` the exact inverse of the respond flow's
        // `already_responded` check, so the two can't disagree.
        notExists(
          systemDb
            .select({ id: surveyResponses.id })
            .from(surveyResponses)
            .where(
              and(
                eq(surveyResponses.invitationId, surveyInvitations.id),
                eq(surveyResponses.orgId, surveyInvitations.orgId),
                isNull(surveyResponses.deletedAt),
              ),
            ),
        ),
        isNull(surveys.deletedAt),
        inArray(surveys.kind, ["pmf", "nps", "csat"]),
      ),
    )
    .orderBy(desc(surveyInvitations.invitedAt));
  return rows.map((r) => ({
    invitationId: r.invitationId,
    surveyId: r.surveyId,
    surveyKind: r.surveyKind as PendingSurveyKind,
    questionFr: r.questionFr,
    questionEn: r.questionEn,
    invitedAt: r.invitedAt,
    expiresAt: r.expiresAt,
  }));
}

/**
 * Mark an invitation as dismissed by the recipient. Sets `dismissed_at`
 * AND `opened_at` so the next launch's cohort-skip filter (which keys
 * on `opened_at IS NULL AND dismissed_at IS NULL`) lets the user
 * receive a fresh invitation on the next cadence tick. Without setting
 * `opened_at` here the invitation would still match the active-pending
 * predicate from the future-launch fan-out and bounce the user out of
 * the cohort indefinitely.
 */
export async function dismissInvitation(input: {
  invitationId: string;
  userId: string;
  orgId: string;
  now?: Date;
}): Promise<DismissResult | DismissError> {
  const now = input.now ?? new Date();
  const [updated] = await systemDb
    .update(surveyInvitations)
    .set({ dismissedAt: now, openedAt: now })
    .where(
      and(
        eq(surveyInvitations.id, input.invitationId),
        eq(surveyInvitations.userId, input.userId),
        eq(surveyInvitations.orgId, input.orgId),
        isNull(surveyInvitations.deletedAt),
      ),
    )
    .returning({ id: surveyInvitations.id, dismissedAt: surveyInvitations.dismissedAt });
  if (!updated?.dismissedAt) {
    return { kind: "invitation_not_found" };
  }
  return { invitationId: updated.id, dismissedAt: updated.dismissedAt };
}
