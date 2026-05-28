/**
 * Survey invitation email processor (issue #444 follow-up).
 *
 * Handles `survey.invitation.send_email` outbox events. The producer
 * (`survey-launch.ts` in the API) emits one event per cohort recipient
 * when the super-admin clicks "Send email now" on the SurveyLaunchCard.
 * Until this processor landed, the events fell through to the
 * `routeDomainEvent` "unhandled" branch and were silently dropped.
 *
 * The payload carries everything we need: invitation id, survey slug,
 * recipient email, expiry. No DB lookup required — the producer
 * already resolved the cohort under its own auth boundary. We just
 * render + send.
 *
 * Magic-link UX: the email CTA points at `${APP_URL}/dashboard`. The
 * authenticated tenant layout mounts `<SurveyInvitationPrompt>`, which
 * polls `/v1/surveys/pending` on first paint and surfaces the modal.
 * No dedicated public landing page exists (yet) — keeps the surface
 * narrow and reuses the in-app rendering for the form. Follow-up
 * could ship a dedicated `/surveys/[id]` page if we want to support
 * unauthenticated responding.
 */

import type { Locale } from "@givernance/shared/i18n";
import { surveys } from "@givernance/shared/schema";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
// The worker's `db` export IS the owner pool (BYPASSRLS) — different
// naming convention from the API where `systemDb` plays that role.
// `surveys` is platform-level + REVOKE'd from `givernance_app`, so
// the owner pool is the right choice here.
import { db } from "../lib/db.js";
import { defaultEmailSender, type EmailSender } from "../lib/email.js";
import { ensureLocale, renderSurveyInvitationEmail } from "../lib/email-templates.js";

export interface SurveyInvitationEmailJobPayload {
  invitationId: string;
  surveyId: string;
  surveySlug: string;
  userId: string | null;
  email: string;
  expiresAt: string;
  source: string;
  locale?: string;
}

export interface SurveyInvitationEmailDeps {
  sender?: EmailSender;
}

export async function processSurveyInvitationEmail(
  payload: SurveyInvitationEmailJobPayload,
  deps: SurveyInvitationEmailDeps = {},
): Promise<{ sent: boolean; reason?: "no_email" | "survey_not_found" }> {
  if (!payload.email) {
    // The producer always fills `email` from `users.email`, but a
    // GDPR-erased recipient could land here with an empty string.
    // Drop quietly — no audience for the email anyway.
    return { sent: false, reason: "no_email" };
  }

  // Fetch the survey question via the platform-level `surveys` table
  // (REVOKE'd from `givernance_app` per migration 0071 → must use
  // systemDb). Keeps the email body in lockstep with whatever copy
  // the super-admin last edited.
  const [survey] = await db
    .select({
      kind: surveys.kind,
      questionFr: surveys.questionFr,
      questionEn: surveys.questionEn,
    })
    .from(surveys)
    .where(eq(surveys.id, payload.surveyId))
    .limit(1);

  if (!survey) {
    return { sent: false, reason: "survey_not_found" };
  }

  const locale = ensureLocale(payload.locale as Locale | undefined);
  const respondUrl = `${env.APP_URL}/dashboard`;
  const question = locale === "fr" ? survey.questionFr : survey.questionEn;

  const rendered = renderSurveyInvitationEmail({
    surveyKind: survey.kind as "pmf" | "nps" | "csat" | "custom",
    question,
    respondUrl,
    expiresAt: new Date(payload.expiresAt),
    locale,
  });

  const sender = deps.sender ?? defaultEmailSender;
  await sender.send({
    to: payload.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return { sent: true };
}
