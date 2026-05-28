// #437 — POST /v1/surveys/:invitationId/respond service.
//
// Tenant-user endpoint (NOT super-admin). Enforces the four invariants
// the privacy posture depends on:
//   1. The invitation must belong to (userId, orgId) of the caller —
//      404, NOT 403, to avoid invitation_id enumeration.
//   2. One response per invitation (DB unique guard + 409 mapping).
//   3. `submitted_at` is server-set NOW(); never trust client values.
//   4. Free-text fields refused if they contain `<` or `>` (XSS
//      defence in depth; the renderer side relies on React's default
//      text-child escaping — never switch to `dangerouslySetInnerHTML`
//      for these fields).
//
// The shared `db` import (RLS-bound) is intentional — even though RLS
// is forced on `survey_invitations` + `survey_responses`, every query
// here ALSO carries explicit `eq(orgId, …)` per CLAUDE.md.

import { surveyInvitations, surveyResponses } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { withTenantContext } from "../../../lib/db.js";

export type RespondError =
  | { kind: "invitation_not_found" }
  | { kind: "already_responded" }
  | { kind: "invalid_text" };

export interface RespondResult {
  responseId: string;
  submittedAt: Date;
}

const FORBIDDEN_TEXT_CHARS = /[<>]/;

function containsForbiddenText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return FORBIDDEN_TEXT_CHARS.test(value);
}

export async function submitSurveyResponse(input: {
  invitationId: string;
  userId: string;
  orgId: string;
  response: {
    score?: number;
    category?: string;
    rating?: number;
    text?: string;
    why_text?: string;
    comment?: string;
  };
  now?: Date;
}): Promise<RespondResult | RespondError> {
  const now = input.now ?? new Date();

  // Defence in depth: refuse `<` / `>` in any free-text field BEFORE
  // hitting the DB. TypeBox already caps maxLength; this catches the
  // XSS pattern that React's default text-child escaping is the
  // only renderer-side guard against (so this layer must hold).
  if (
    containsForbiddenText(input.response.text) ||
    containsForbiddenText(input.response.why_text) ||
    containsForbiddenText(input.response.comment)
  ) {
    return { kind: "invalid_text" };
  }

  // Wrap the lookup + conflict check + insert+update in a single
  // `withTenantContext` transaction so the RLS GUC
  // (`app.current_organization_id`) is set on every query. Without
  // this, the `givernance_app` runtime role hits the
  // `tenant_isolation` policy on `survey_invitations` /
  // `survey_responses` and every SELECT returns zero rows — manifests
  // as a 404 in dev/prod (tests pass only because the test env falls
  // back to the owner role). Explicit eq(userId)+eq(orgId) stays as
  // the contract per CLAUDE.md "RLS is the safety net, never the
  // contract".
  return withTenantContext(input.orgId, async (tx) => {
    const [invitation] = await tx
      .select({
        id: surveyInvitations.id,
        orgId: surveyInvitations.orgId,
      })
      .from(surveyInvitations)
      .where(
        and(
          eq(surveyInvitations.id, input.invitationId),
          eq(surveyInvitations.userId, input.userId),
          eq(surveyInvitations.orgId, input.orgId),
          isNull(surveyInvitations.deletedAt),
        ),
      )
      .limit(1);

    if (!invitation) {
      return { kind: "invitation_not_found" };
    }

    const [existing] = await tx
      .select({ id: surveyResponses.id })
      .from(surveyResponses)
      .where(
        and(
          eq(surveyResponses.invitationId, invitation.id),
          eq(surveyResponses.orgId, invitation.orgId),
          isNull(surveyResponses.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      return { kind: "already_responded" };
    }

    const [row] = await tx
      .insert(surveyResponses)
      .values({
        invitationId: invitation.id,
        orgId: invitation.orgId,
        response: input.response,
        submittedAt: now,
      })
      .returning({ id: surveyResponses.id, submittedAt: surveyResponses.submittedAt });

    if (!row) {
      throw new Error("survey response insert returned no row");
    }

    await tx
      .update(surveyInvitations)
      .set({ openedAt: now })
      .where(
        and(
          eq(surveyInvitations.id, invitation.id),
          eq(surveyInvitations.orgId, invitation.orgId),
          isNull(surveyInvitations.openedAt),
        ),
      );

    return { responseId: row.id, submittedAt: row.submittedAt };
  });
}
