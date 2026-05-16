-- Migration: 0055_notifications_center (Epic #363, single PR)
--
-- In-app notification centre (GLO-004). One PR delivers schema +
-- producer + API + UI + preferences + SSE + email digest scaffolding,
-- all gated behind `communication.notifications_center` (default OFF).
--
-- This migration ships:
--   1. The `communication.notifications_center` feature-flag seed row.
--   2. `notifications` — one row per (recipient, event). Tenant-scoped,
--      RLS-isolated, soft-delete universal.
--   3. `notification_preferences` — per (user, type) channel matrix
--      (in-app on/off, email-digest on/off). Tenant-scoped, RLS.
--
-- Design notes (full rationale in `docs/adrs/adr-031-notifications.md`
-- and `docs/27-notifications.md`):
--
--   * Recipient resolution happens in the worker, NOT in the producer.
--     The same outbox event (e.g. `donation.created`) may fan out to
--     multiple recipients (every org_admin of the tenant), and the
--     producer doesn't know who they are. The worker subscribes to
--     outbox events via `processDomainEvent` (existing infra — Epic
--     #274/#286/#326) and inserts N notification rows per event inside
--     `withWorkerContext`. RLS isolates the writes to the originating
--     tenant.
--
--   * `type` is `varchar(64)`, NOT a Postgres enum. Adding a new
--     notification type ("campaign_postal_export_completed") is a code
--     change in `NOTIFICATION_TYPE_VALUES` + a producer wiring, never a
--     migration. The CHECK constraint pins the allowed prefixes so a
--     buggy producer can't insert `null` / empty / oversized strings.
--
--   * `title_key` + `body_key` + `params jsonb` instead of frozen
--     `text`. A French org_admin sees French even when the producer
--     ran in an English worker — the i18n interpolation happens at the
--     READ boundary (web panel, email digest), not at write time. This
--     matches the per-tenant locale model already in `users.locale`.
--
--   * `link_url` is a relative path (e.g. `/donations/<uuid>`) — the
--     frontend prepends `APP_URL`. Storing absolute URLs would break
--     when a tenant moves to a custom subdomain (Epic #279 follow-up).
--
--   * Soft-delete is universal per `feedback_soft_delete_universal` —
--     a notification a user "deletes" from the panel is kept in the DB
--     with `deleted_at = NOW()` so the audit chain stays queryable. The
--     RLS policy + every read query filters `deleted_at IS NULL`.
--
--   * Index on `(user_id, read_at) WHERE read_at IS NULL AND
--     deleted_at IS NULL` keeps the bell-badge query
--     (`SELECT COUNT(*)`) O(log N) even on a busy tenant. Per-user
--     ordering uses `(user_id, created_at DESC)`.
--
--   * `notification_preferences` is one row per `(user_id, type)`.
--     Missing rows fall back to the per-type default in
--     `NOTIFICATION_TYPE_DEFAULTS` (shared/constants/notifications.ts)
--     — saves an INSERT for every user on registration.
--
-- Idempotent — `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` per the
-- `feedback_never_modify_applied_migrations` rule.

-- ─── Feature-flag seed ──────────────────────────────────────────────

INSERT INTO feature_flags (
  key,
  enabled,
  label,
  description,
  scope,
  tenant_override_allowed,
  public
)
VALUES (
  'communication.notifications_center',
  FALSE,
  'In-app notification centre',
  'Adds a bell icon to the top bar with a panel that lists what happened in your organisation — new donations, postal-export downloads, team invitations, and more. Each member can choose which alerts they want from the Settings menu. Off by default until Givernance staff confirm the bell, panel, and per-member preferences for your organisation.',
  'tenant',
  FALSE,
  TRUE
)
ON CONFLICT (key) DO NOTHING;

-- ─── notifications ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Tenant boundary — RLS policy keys on this column.
  org_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Recipient. SET NULL on user purge so a GDPR-erased account doesn't
  -- FK-block historical notifications. The orphaned rows are then
  -- garbage-collected by the universal soft-delete sweep (out of scope
  -- for this Epic — tracked under ADR-021 cleanup).
  user_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
  -- Discriminator. Code-side const = `NOTIFICATION_TYPE_VALUES`.
  -- CHECK below pins shape: lowercase dotted-namespace, ≤ 64 chars.
  type         VARCHAR(64)  NOT NULL,
  -- i18n keys — resolved at READ time so a French user sees French
  -- even when the worker that wrote the row was processing a request
  -- from an English session.
  title_key    VARCHAR(128) NOT NULL,
  body_key     VARCHAR(128) NOT NULL,
  -- Interpolation params (e.g. `{donorName: "...", amountCents: 1500}`).
  -- Defaults to `{}` so a downstream renderer can always do
  -- `params[key]` without null-checking. PII guidance in
  -- `docs/27-notifications.md` § GDPR: only opaque ids + non-sensitive
  -- counters; full donor names are dereferenced client-side via the
  -- `link_url` page.
  params       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Relative path (e.g. `/donations/<uuid>`). Frontend prepends
  -- APP_URL. NULL means the notification is informational only and
  -- doesn't have a click-through target.
  link_url     TEXT,
  -- NULL until the user marks read (single read or read-all).
  read_at      TIMESTAMPTZ,
  -- NULL until archived from the panel. Archived ≠ deleted: a row can
  -- be read AND archived; the panel hides archived rows from the
  -- default view.
  archived_at  TIMESTAMPTZ,
  -- Soft-delete (ADR-021 universal). A panel "delete" sets this; the
  -- row stays for audit / GDPR DSR replay.
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT notifications_type_chk
    CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  CONSTRAINT notifications_link_url_chk
    CHECK (link_url IS NULL OR link_url LIKE '/%')
);

-- Per-user, time-ordered listing (panel + email digest).
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- Bell-badge unread-count query — narrow partial index so the count
-- doesn't scan archived/read rows on a noisy tenant.
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id)
  WHERE read_at IS NULL AND deleted_at IS NULL;

-- Tenant-level admin / debug queries (Back Office "view all rows for
-- tenant X"). Filters by org_id then orders by created_at.
CREATE INDEX IF NOT EXISTS notifications_org_created_idx
  ON notifications (org_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON notifications
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO givernance_app;

-- ─── notification_preferences ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_preferences (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Same shape as notifications.type. References-by-string keeps the
  -- table writable when a new type lands without an FK reorg.
  type            VARCHAR(64) NOT NULL,
  -- Channel matrix. `in_app=false` hides the row from the panel + bell
  -- count; `email_digest=true` includes it in the weekly digest worker
  -- (Phase 5; opt-in).
  in_app          BOOLEAN     NOT NULL DEFAULT TRUE,
  email_digest    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT notification_preferences_type_chk
    CHECK (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  -- One row per (user, type). Upsert key for the PATCH route.
  CONSTRAINT notification_preferences_user_type_unique
    UNIQUE (user_id, type)
);

CREATE INDEX IF NOT EXISTS notification_preferences_user_idx
  ON notification_preferences (user_id);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY tenant_isolation ON notification_preferences
    USING (org_id = app_current_organization_id());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO givernance_app;
