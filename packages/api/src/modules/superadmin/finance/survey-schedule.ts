// #437 — POST /v1/superadmin/surveys/:slug/schedule service.
//
// Sets the cadence (and matching next_scheduled_at) on a survey
// definition. Idempotent on `(survey_id, cadence)` — re-applying the
// current cadence is a no-op.

import { surveys } from "@givernance/shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import { systemDb } from "../../../lib/db.js";

export type CadenceName = "quarterly_minus_7d" | "monthly" | "continuous";

const CADENCE_DAYS: Record<CadenceName, number | null> = {
  quarterly_minus_7d: 90,
  monthly: 30,
  // Continuous = no scheduler-driven re-fanout. The continuous channel
  // is post-ticket / event-driven; the survey row still exists for
  // the dashboard to read but the cron loop skips it.
  continuous: null,
};

const NEXT_RUN_OFFSET_DAYS: Record<CadenceName, number | null> = {
  // -7d so the quarterly sweep lands a week before the cadence boundary,
  // giving CSMs time to react before the next quarter starts.
  quarterly_minus_7d: 90 - 7,
  monthly: 30,
  continuous: null,
};

export type ScheduleError = { kind: "survey_not_found" };

export interface ScheduleResult {
  surveyId: string;
  cadence: CadenceName;
  cadenceDays: number | null;
  nextScheduledAt: Date | null;
  noOp: boolean;
}

export async function scheduleSurvey(input: {
  slug: string;
  cadence: CadenceName;
  now?: Date;
}): Promise<ScheduleResult | ScheduleError> {
  const now = input.now ?? new Date();
  const desiredCadenceDays = CADENCE_DAYS[input.cadence];
  const offsetDays = NEXT_RUN_OFFSET_DAYS[input.cadence];

  const [survey] = await systemDb
    .select({
      id: surveys.id,
      cadenceDays: surveys.cadenceDays,
      nextScheduledAt: surveys.nextScheduledAt,
    })
    .from(surveys)
    .where(and(eq(surveys.slug, input.slug), isNull(surveys.deletedAt)))
    .limit(1);

  if (!survey) {
    return { kind: "survey_not_found" };
  }

  // No-op: cadence already matches.
  if (survey.cadenceDays === desiredCadenceDays) {
    return {
      surveyId: survey.id,
      cadence: input.cadence,
      cadenceDays: survey.cadenceDays,
      nextScheduledAt: survey.nextScheduledAt,
      noOp: true,
    };
  }

  const nextScheduledAt =
    offsetDays === null
      ? null
      : (() => {
          const next = new Date(now);
          next.setUTCDate(next.getUTCDate() + offsetDays);
          return next;
        })();

  await systemDb
    .update(surveys)
    .set({
      cadenceDays: desiredCadenceDays,
      nextScheduledAt,
      updatedAt: now,
    })
    .where(eq(surveys.id, survey.id));

  return {
    surveyId: survey.id,
    cadence: input.cadence,
    cadenceDays: desiredCadenceDays,
    nextScheduledAt,
    noOp: false,
  };
}
