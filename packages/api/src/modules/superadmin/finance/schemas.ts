// #437 — TypeBox schemas for the super-admin finance dashboard.
//
// Every nested object carries `additionalProperties: false` so a
// future schema diff cannot silently leak a new column — critical
// for the `donations.stripe_fee_cents` tenant-projection lock
// (security-architect BLOCKING in Epic #434).

import { Type } from "@sinclair/typebox";
import { UuidSchema, UuidV4Schema } from "../../../lib/schemas.js";

const StrictObject = Type.Object;

export const PeriodSchema = Type.Union([
  Type.Literal("today"),
  Type.Literal("7d"),
  Type.Literal("30d"),
  Type.Literal("90d"),
  Type.Literal("ytd"),
  Type.Literal("custom"),
]);

export const SummaryCurrencySchema = Type.Union([
  Type.Literal("EUR"),
  Type.Literal("GBP"),
  Type.Literal("CHF"),
  Type.Literal("all"),
]);

export const SummaryQuery = Type.Object(
  {
    period: PeriodSchema,
    from: Type.Optional(Type.String({ format: "date" })),
    to: Type.Optional(Type.String({ format: "date" })),
    currency: Type.Optional(SummaryCurrencySchema),
    tenantId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);

const GradeSchema = Type.Union([
  Type.Literal("A+"),
  Type.Literal("A"),
  Type.Literal("B"),
  Type.Literal("C"),
  Type.Literal("D"),
]);

const MobilisationComponentsSchema = StrictObject(
  {
    activation: Type.Number(),
    recurrence: Type.Number(),
    scale: Type.Number(),
    growth: Type.Number(),
    diversity: Type.Number(),
  },
  { additionalProperties: false },
);

const DeltasSchema = StrictObject(
  {
    volumePercent: Type.Number(),
    platformFeePercent: Type.Number(),
    stripeFeePercent: Type.Union([Type.Number(), Type.Null()]),
    donorCountPercent: Type.Number(),
    refundedVolumePercent: Type.Number(),
    recurringMrrPercent: Type.Number(),
  },
  { additionalProperties: false },
);

const KpisSchema = StrictObject(
  {
    volumeCents: Type.Integer(),
    platformFeeCents: Type.Integer(),
    stripeFeeCents: Type.Union([Type.Integer(), Type.Null()]),
    donorCount: Type.Integer(),
    refundedVolumeCents: Type.Integer(),
    recurringMrrCents: Type.Integer(),
    activeTenantsCount: Type.Integer(),
    paymentFailureRate: Type.Union([Type.Number(), Type.Null()], {
      description:
        "Stripe-only payment failure rate (%). Mollie attempts are not recorded in payment_attempts and are therefore excluded from both numerator and denominator.",
    }),
    hhi: Type.Number(),
    deltas: DeltasSchema,
  },
  { additionalProperties: false },
);

const MobilisationPerTenantRowSchema = StrictObject(
  {
    tenantId: UuidSchema,
    tenantName: Type.String(),
    grade: Type.Union([GradeSchema, Type.Null()]),
    score: Type.Union([Type.Number(), Type.Null()]),
    components: MobilisationComponentsSchema,
    isAnonymised: Type.Boolean(),
  },
  { additionalProperties: false },
);

const MobilisationSchema = StrictObject(
  {
    platformGrade: Type.Union([GradeSchema, Type.Null()]),
    platformScore: Type.Union([Type.Number(), Type.Null()]),
    components: MobilisationComponentsSchema,
    perTenant: Type.Array(MobilisationPerTenantRowSchema),
  },
  { additionalProperties: false },
);

const SurveyRowSchema = StrictObject(
  {
    kind: Type.Union([Type.Literal("pmf"), Type.Literal("nps"), Type.Literal("csat")]),
    slug: Type.String(),
    lastCollectedAt: Type.Union([Type.String(), Type.Null()]),
    nextScheduledAt: Type.Union([Type.String(), Type.Null()]),
    responseCount: Type.Integer(),
    invitedCount: Type.Integer(),
    pmfPercent: Type.Union([Type.Number(), Type.Null()]),
    npsScore: Type.Union([Type.Number(), Type.Null()]),
    csatScore: Type.Union([Type.Number(), Type.Null()]),
    isStatisticallySignificant: Type.Boolean(),
  },
  { additionalProperties: false },
);

const TimeseriesPointSchema = StrictObject(
  {
    date: Type.String(),
    volumeCents: Type.Integer(),
    platformFeeCents: Type.Integer(),
  },
  { additionalProperties: false },
);

const PerTenantRowSchema = StrictObject(
  {
    tenantId: UuidSchema,
    tenantName: Type.String(),
    volumeCents: Type.Integer(),
    platformFeeCents: Type.Integer(),
    donationCount: Type.Integer(),
  },
  { additionalProperties: false },
);

const PerCurrencyRowSchema = StrictObject(
  {
    currency: Type.String(),
    volumeCents: Type.Integer(),
    donationCount: Type.Integer(),
  },
  { additionalProperties: false },
);

const PeriodWindowSchema = StrictObject(
  {
    from: Type.String(),
    to: Type.String(),
    label: Type.String(),
    comparisonFrom: Type.String(),
    comparisonTo: Type.String(),
  },
  { additionalProperties: false },
);

export const SummaryResponse = Type.Object(
  {
    data: StrictObject(
      {
        period: PeriodWindowSchema,
        kpis: KpisSchema,
        mobilisation: MobilisationSchema,
        surveys: Type.Array(SurveyRowSchema),
        timeseries: Type.Array(TimeseriesPointSchema),
        perTenant: Type.Array(PerTenantRowSchema),
        perCurrency: Type.Array(PerCurrencyRowSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

// ─── Survey lifecycle ──────────────────────────────────────────────────────

export const SurveySlugParams = Type.Object(
  {
    slug: Type.String({ pattern: "^[a-z0-9_-]{1,64}$" }),
  },
  { additionalProperties: false },
);

export const LaunchBody = Type.Object(
  {
    channel: Type.Union([Type.Literal("email"), Type.Literal("in_app")]),
  },
  { additionalProperties: false },
);

export const LaunchResponse = Type.Object(
  {
    data: StrictObject(
      {
        launchId: UuidSchema,
        surveyId: UuidSchema,
        channel: Type.Union([Type.Literal("email"), Type.Literal("in_app")]),
        recipientCount: Type.Integer(),
        launchedAt: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ScheduleBody = Type.Object(
  {
    cadence: Type.Union([
      Type.Literal("quarterly_minus_7d"),
      Type.Literal("monthly"),
      Type.Literal("continuous"),
    ]),
  },
  { additionalProperties: false },
);

export const ScheduleResponse = Type.Object(
  {
    data: StrictObject(
      {
        surveyId: UuidSchema,
        cadence: Type.Union([
          Type.Literal("quarterly_minus_7d"),
          Type.Literal("monthly"),
          Type.Literal("continuous"),
        ]),
        cadenceDays: Type.Union([Type.Integer(), Type.Null()]),
        nextScheduledAt: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

// ─── Survey response (tenant user) ─────────────────────────────────────────

export const InvitationIdParams = Type.Object(
  {
    // Invitation tokens are minted as UUID v4 (Epic #434 security-architect
    // BLOCKING) — accept v4 only on the wire so malformed/non-v4 tokens fail
    // closed at the schema layer rather than reaching the DB lookup.
    invitationId: UuidV4Schema,
  },
  { additionalProperties: false },
);

export const RespondBody = Type.Object(
  {
    response: Type.Object(
      {
        score: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
        category: Type.Optional(
          Type.Union([
            Type.Literal("very_disappointed"),
            Type.Literal("somewhat_disappointed"),
            Type.Literal("not_disappointed"),
          ]),
        ),
        rating: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
        text: Type.Optional(Type.String({ maxLength: 2000 })),
        why_text: Type.Optional(Type.String({ maxLength: 2000 })),
        comment: Type.Optional(Type.String({ maxLength: 2000 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const RespondResponse = Type.Object(
  {
    data: Type.Object(
      {
        responseId: UuidSchema,
        submittedAt: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

// ─── Cache flush (#449) ─────────────────────────────────────────────────
// Response shape for POST /v1/superadmin/finance/cache/flush. No request
// body — pattern is hardcoded server-side to prevent any client-controlled
// SCAN scope.
export const CacheFlushResponse = Type.Object(
  {
    data: StrictObject(
      {
        keysDeleted: Type.Integer({ minimum: 0 }),
        pattern: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

// ─── Monthly platform finance report (issue #443) ──────────────────────────

const MonthSchema = Type.String({
  pattern: "^\\d{4}-(0[1-9]|1[0-2])$",
  description: "Calendar month label YYYY-MM (e.g. '2026-04').",
});

const ReportStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);

export const ReportIdParams = Type.Object({ id: UuidSchema }, { additionalProperties: false });

export const MonthlyReportBody = Type.Object(
  {
    /**
     * Optional explicit month — defaults to the most recent
     * fully-completed calendar month. Set this to re-run an older
     * month after a fix or for QA.
     */
    month: Type.Optional(MonthSchema),
  },
  { additionalProperties: false },
);

const ReportSchema = StrictObject(
  {
    id: UuidSchema,
    month: MonthSchema,
    status: ReportStatusSchema,
    failureReason: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    readyAt: Type.Union([Type.String(), Type.Null()]),
    /** Path-relative URL of the streamed PDF (only when status='ready'). */
    pdfUrl: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const MonthlyReportResponse = Type.Object(
  { data: ReportSchema },
  { additionalProperties: false },
);
