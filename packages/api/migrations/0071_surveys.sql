-- Migration: 0071_surveys (Epic #434, issue #435; full domain in docs/32)
--
-- New `surveys` table — registry of survey definitions used by the
-- tenant-health side of the super-admin dashboard (PMF Sean Ellis,
-- NPS, CSAT, custom). The actual invitations + responses live in
-- `survey_invitations` (0072) and `survey_responses` (0073).
--
-- PLATFORM-LEVEL TABLE: no `org_id`, no RLS. Surveys are authored by
-- Givernance staff (super-admin only) and apply across the whole
-- platform — the per-tenant scoping happens at the invitations
-- table. Accessed exclusively through `systemDb` (BYPASSRLS owner
-- pool) — REVOKE on `givernance_app` so an accidental query through
-- the tenant-scoped pool fails loud.
--
-- `kind` is a CHECK-constrained text field rather than a Postgres
-- enum so adding a custom survey kind ("onboarding_pulse",
-- "support_handoff") is a code-only change — the same trade-off as
-- `notifications.type` in migration 0055.
--
-- `slug` is the public stable identifier used in the API routes
-- (`POST /v1/superadmin/surveys/:slug/launch`). Regex-constrained to
-- the URL-safe shape so a malformed slug can't slip into a route
-- handler.
--
-- `cohort_rule` JSONB carries the targeting predicate ({"role":
-- "org_admin", "tenant_min_age_days": 14}). Evaluated by the survey
-- worker — out of scope for this migration.
--
-- `freshness_soon_days` + `freshness_stale_days` are the bands the
-- `fresh-pip` UI uses ("ok" / "soon" / "stale"). Per-survey because
-- PMF/NPS are quarterly (90d / 180d) while CSAT is continuous
-- (30d / 90d).
--
-- Soft-delete + universal `deleted_at` (ADR-021). The slug uniqueness
-- index is partial on `deleted_at IS NULL` so a retired survey can be
-- re-introduced with the same slug later without conflict (mirrors
-- ADR-021 users-by-email re-bind pattern; the schema-parity test
-- enforces partial-unique on soft-deleted tables).

CREATE TABLE surveys (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  TEXT         NOT NULL,
  slug                  TEXT         NOT NULL,
  question_fr           TEXT         NOT NULL,
  question_en           TEXT         NOT NULL,
  -- Survey-specific options. Free-form JSON because the shape varies
  -- per `kind`: PMF stores {"thresholds": {...}}, NPS stores the 0-10
  -- scale labels, CSAT stores the emoji set, etc.
  options               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Targeting predicate evaluated by the survey worker. Empty `{}`
  -- means "every org_admin of every active tenant".
  cohort_rule           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- NULL = one-shot; integer = re-send every N days per recipient.
  cadence_days          INTEGER,
  freshness_soon_days   INTEGER      NOT NULL,
  freshness_stale_days  INTEGER      NOT NULL,
  -- Soft target for the dashboard "n=NN" representativeness counter.
  -- NULL when no minimum threshold applies (custom surveys).
  response_target       INTEGER,
  -- Worker reads this to decide when to re-fanout.
  next_scheduled_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ,

  CONSTRAINT surveys_kind_chk
    CHECK (kind IN ('pmf', 'nps', 'csat', 'custom')),
  CONSTRAINT surveys_slug_chk
    CHECK (slug ~ '^[a-z0-9_-]{1,64}$'),
  -- soon-band must be < stale-band; degenerate values would break the
  -- band classifier UI.
  CONSTRAINT surveys_freshness_bands_chk
    CHECK (freshness_soon_days > 0 AND freshness_stale_days > freshness_soon_days)
);

-- Partial unique on slug — gated on `deleted_at IS NULL` per ADR-021
-- + schema-parity test guard.
CREATE UNIQUE INDEX surveys_slug_uniq
  ON surveys (slug)
  WHERE deleted_at IS NULL;

CREATE INDEX surveys_kind_slug_idx
  ON surveys (kind, slug);

-- Lock down: this table is authored by super-admins through
-- `systemDb`. The tenant-scoped runtime role MUST NOT touch it (no
-- SELECT either — the API exposes survey metadata via a curated
-- projection on the dashboard payload, not by direct query).
REVOKE ALL ON surveys FROM givernance_app;
