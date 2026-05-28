/**
 * Frontend type boundary for tenant-user survey endpoints (issue #444).
 *
 * Per ADR-013, the web package never imports `packages/api` internals
 * — these shapes are hand-mirrored from the TypeBox schemas in
 * `packages/api/src/modules/superadmin/finance/schemas.ts`. The auth
 * boundary differs from the super-admin finance models in
 * `superadmin-finance.ts` (this surface is `requireAuth` rather than
 * `requireSuperAdmin`), which is why it lives in its own file.
 */

export type PendingSurveyKind = "pmf" | "nps" | "csat";

export type PmfCategory = "very_disappointed" | "somewhat_disappointed" | "not_disappointed";

export interface PendingSurveyInvitation {
  invitationId: string;
  surveyId: string;
  surveyKind: PendingSurveyKind;
  questionFr: string;
  questionEn: string;
  invitedAt: string;
  expiresAt: string;
}

export interface PendingSurveyResponse {
  data: PendingSurveyInvitation[];
}

export interface SurveyResponsePayload {
  score?: number;
  category?: PmfCategory;
  rating?: number;
  text?: string;
  why_text?: string;
  comment?: string;
}

export interface SurveyRespondPayload {
  response: SurveyResponsePayload;
}

export interface SurveyRespondApiResponse {
  data: {
    responseId: string;
    submittedAt: string;
  };
}

export interface SurveyDismissResponse {
  data: {
    invitationId: string;
    dismissedAt: string;
  };
}

/**
 * True when the current per-kind input has been filled. Pure helper
 * extracted so the modal and any future test can share the same
 * decision rule (a missing PMF category / NPS score / CSAT rating
 * means the Submit button stays disabled).
 */
export function isSurveyResponseComplete(
  kind: PendingSurveyKind,
  payload: SurveyResponsePayload,
): boolean {
  if (kind === "pmf") return payload.category !== undefined;
  if (kind === "nps") return payload.score !== undefined;
  return payload.rating !== undefined;
}
