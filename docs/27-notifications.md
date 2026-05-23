# 27 — In-app Notification Centre (GLO-004)

> Related: [`docs/14-screen-inventory.md`](14-screen-inventory.md) GLO-004, [`docs/17-log-management.md`](17-log-management.md), [`docs/18-feature-flags.md`](18-feature-flags.md), [`docs/adrs/adr-031-notifications-delivery-and-fanout.md`](adrs/adr-031-notifications-delivery-and-fanout.md), [`diagrams/notifications-flow.mmd`](../diagrams/notifications-flow.mmd), [Epic #363](https://github.com/purposestack/givernance/issues/363).
>
> Migration that ships the schema: [`packages/api/migrations/0055_notifications_center.sql`](../packages/api/migrations/0055_notifications_center.sql).
> Feature flag: `communication.notifications_center` (default off, scope `tenant`).

## 0. Why this exists — at a glance

Givernance's async surface area is growing — postal exports (Epic #274), branding pipelines (Epic #286), Swiss QR-bill bank reconciliation (Epic #318), bulk emails (Epic #326). Each of these produces work the operator initiated and now wants to know about: "did the export finish?", "did the donation come through?", "did the invitee actually accept?". The audit log already records these events but is tenant-wide and admin-only. **There is no per-user, per-event signal anywhere in the product today.**

This Epic ships the missing surface: a topbar bell with an unread badge, a side panel listing recent events filtered by category, per-user preferences for which alerts to receive and on which channel (in-app / email digest), and real-time delivery via SSE with a polling fallback.

The architecture leans on infrastructure already proven in production: the transactional outbox + BullMQ worker (Epic #274, #286, #326), the feature-flag scaffolding (Epic #326, #365), and the RLS / soft-delete patterns (ADR-021). Adding this surface is a fan-out at the worker, a single Fastify module, a topbar component, and a settings sub-page — no new infrastructure, no new tools.

A future `docs/27` revision will fold AI aggregation ("3 similar grant-deadline alerts grouped"), push notifications, and SMS into the same model; those are explicitly out of scope for this Epic and live in [§ 7](#7-out-of-scope).

## 1. End-to-end user flow

The shipped MVP covers six notification types — one per "thing an operator initiated that runs async":

| Type | Producer event | Recipients | Visual | Default in-app | Default email digest |
|---|---|---|---|---|---|
| `donation.received` | `donation.created` | every `org_admin` of the tenant | donation (green) | on | off |
| `invitation.created` | `invitation.created` | every `org_admin` of the tenant | team (indigo) | on | off |
| `invitation.resent` | `invitation.resent` | every `org_admin` of the tenant | team (indigo) | off | off |
| `branding.logo_synced` | `branding.activate_logo` | every `org_admin` of the tenant | system (sky) | on | off |
| `postal_export.queued` | `campaign.postal_export_requested` | requester (fallback: org_admins) | system (sky) | on | off |
| `bulk_email.queued` | `communication.bulk_email_requested` | requester (fallback: org_admins) | team (indigo) | on | off |

```mermaid
sequenceDiagram
  autonumber
  actor Operator as Org admin
  participant API as Fastify API
  participant DB as Postgres (RLS)
  participant Relay as Outbox relay
  participant Worker as BullMQ worker
  participant Bell as Topbar bell
  participant Panel as Notifications panel

  Operator->>API: POST /v1/donations (creates donation)
  API->>DB: INSERT donation + outbox_events (same tx)
  API-->>Operator: 201 Created
  Relay->>DB: SELECT pending outbox_events FOR UPDATE SKIP LOCKED
  Relay->>Worker: enqueue { type: "donation.created", payload }
  Worker->>Worker: fanoutNotifications(event)
  Worker->>Worker: flag check: communication.notifications_center?
  alt flag off
    Worker-->>Worker: skip — log debug
  else flag on
    Worker->>DB: SELECT users WHERE role='org_admin'<br/>+ honour notification_preferences (in_app)
    Worker->>DB: INSERT notifications (one per recipient)
  end
  Worker->>Worker: routeDomainEvent → existing receipt PDF job
  Bell->>API: EventSource /v1/notifications/stream
  API->>DB: SELECT new rows WHERE created_at > cursor (polling loop)
  API-->>Bell: event: notification (SSE frame)
  Bell->>Panel: re-render badge + new row at the top
  Operator->>Panel: clicks row → /donations/<id>
  Panel->>API: PATCH /v1/notifications/:id/read
  API->>DB: UPDATE read_at = NOW()
```

### Off-state behaviour (flag off)

- Topbar has no bell icon at all (off-state QA per `feedback_feature_flag_first`).
- `/v1/notifications*` + `/v1/notification-preferences*` routes return 404 (anti-disclosure — same posture as `/v1/constituents/bulk-email`).
- `/profile/notifications` returns 404 (the page itself re-checks the flag SSR).
- Outbox-fanout worker silently no-ops on every event.
- Email-digest BullMQ tick reads the flag, sees off, returns.

## 2. Architecture overview

```mermaid
flowchart LR
  subgraph "API (Fastify 5)"
    A1[POST /v1/donations]
    A2[GET /v1/notifications]
    A3[GET /v1/notifications/stream]
    A4[PATCH /v1/notification-preferences/:type]
  end

  subgraph "Worker (BullMQ)"
    W1[processDomainEvent]
    W2[fanoutNotifications]
    W3[Daily digest tick]
  end

  subgraph "Postgres (RLS app role)"
    DB1[(outbox_events)]
    DB2[(notifications)]
    DB3[(notification_preferences)]
  end

  subgraph "Web (Next.js)"
    UI1[Topbar bell]
    UI2[Notifications panel]
    UI3[/profile/notifications/]
  end

  A1 -->|tx| DB1
  DB1 -->|relay → BullMQ| W1
  W1 --> W2
  W2 -->|withWorkerContext| DB2
  W3 -->|read each tenant + send digest| DB2
  UI1 -->|SSE| A3
  UI1 -->|polling fallback| A2
  UI2 --> A2
  UI3 --> A4
  A2 -->|withTenantContext| DB2
  A4 --> DB3
```

### Code boundaries

| Concern | Package | File(s) |
|---|---|---|
| Schema (Drizzle) | `packages/shared/src/schema/notifications.ts` | `notifications`, `notification_preferences` |
| Type registry | `packages/shared/src/constants/notifications.ts` | `NOTIFICATION_TYPE_VALUES`, `NOTIFICATION_TYPE_REGISTRY` |
| Feature flag | `packages/shared/src/constants/feature-flags.ts` | `COMMUNICATION_NOTIFICATIONS_CENTER` |
| Migration | `packages/api/migrations/0055_notifications_center.sql` | seed + table + RLS |
| Fanout producer | `packages/worker/src/processors/notifications-fanout.ts` | `fanoutNotifications`, `planFanout` |
| Worker wiring | `packages/worker/src/worker.ts` | `processDomainEvent` calls fanout first |
| Email digest job | `packages/worker/src/processors/notifications-email-digest.ts` | `processNotificationsEmailDigest` |
| API routes | `packages/api/src/modules/notifications/routes.ts` | REST + SSE |
| API service | `packages/api/src/modules/notifications/service.ts` | list + cursor + RLS reads |
| Web service | `packages/web/src/services/NotificationsService.ts` | API client wrapper |
| Web live hook | `packages/web/src/components/notifications/use-notifications-live.ts` | SSE + polling fallback |
| Topbar bell | `packages/web/src/components/notifications/notifications-bell.tsx` | trigger + badge |
| Panel | `packages/web/src/components/notifications/notifications-panel.tsx` | filter chips + rows |
| Preferences page | `packages/web/src/app/(app)/profile/notifications/page.tsx` | SSR + form |
| Preferences form | `packages/web/src/components/notifications/notification-preferences-form.tsx` | optimistic checkboxes |

## 3. Data model

```mermaid
erDiagram
  TENANTS ||--o{ NOTIFICATIONS : "scopes"
  USERS ||--o{ NOTIFICATIONS : "is recipient"
  TENANTS ||--o{ NOTIFICATION_PREFERENCES : "scopes"
  USERS ||--o{ NOTIFICATION_PREFERENCES : "owns"
  OUTBOX_EVENTS ||..o{ NOTIFICATIONS : "fans out (via worker)"

  NOTIFICATIONS {
    uuid id PK
    uuid org_id FK
    uuid user_id FK
    varchar(64) type
    varchar(128) title_key
    varchar(128) body_key
    jsonb params
    text link_url
    boolean panel_visible
    timestamptz read_at
    timestamptz archived_at
    timestamptz deleted_at
    timestamptz created_at
  }

  NOTIFICATION_PREFERENCES {
    uuid id PK
    uuid org_id FK
    uuid user_id FK
    varchar(64) type
    boolean in_app
    boolean email_digest
    timestamptz created_at
    timestamptz updated_at
  }
```

### Field rationale

- **`type` is `varchar(64)`** with a CHECK constraint on shape (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`), NOT a Postgres enum. Adding a new type is a code change + producer wiring, never a migration.
- **`(title_key, body_key, params)` instead of frozen `text`** — i18n resolution at READ time. A French recipient sees French regardless of the worker's session locale.
- **`link_url` is a relative path** (CHECK `link_url LIKE '/%'`). Frontend prepends `APP_URL`. Absolute URLs would break for tenants on custom subdomains (Epic #279 follow-up). The **email digest renderer** prepends `APP_URL` itself before serialising the href: an email client renders against its own base URL (in dev, Mailpit at `http://localhost:8025`), so a stored relative path would deliver a broken link. Resolution happens in `notifications-email-digest.ts → absoluteUrl()`.
- **`deleted_at` (soft-delete)** per `feedback_soft_delete_universal` — a panel "delete" sets the column; the row stays for audit + GDPR DSR replay.
- **Partial index `(user_id) WHERE read_at IS NULL AND deleted_at IS NULL`** keeps the bell badge query O(log N) on a noisy tenant.

### Recipient resolution

The worker's `planFanout(event)` resolves recipients per the table in [§ 1](#1-end-to-end-user-flow). For "specific user" rules (postal export, bulk email), the payload carries `requestedBy` — if absent (older events, super-admin actions), the rule falls back to "all org_admins". The fanout writes a `notifications` row when EITHER `in_app` OR `email_digest` is enabled for the recipient's (user, type) pair; the row's `panel_visible` column records the panel-side decision at write time so the in-app surface honours `in_app=false` while the digest worker can still pick the row up. Users who opted out of BOTH channels are silently dropped before any row is written.

### Channel decoupling (`panel_visible`, migration 0058)

`in_app` and `email_digest` are two independent delivery channels. The original Epic #363 contract coupled them — `in_app=false` short-circuited the row insert, leaving the digest worker with nothing to read. Migration 0058 introduces `notifications.panel_visible BOOLEAN NOT NULL DEFAULT TRUE`, set at fanout time to the recipient's effective `in_app` preference:

| Effective `in_app` | Effective `email_digest` | Row written? | `panel_visible` | Panel sees it? | Digest sees it? |
|---|---|---|---|---|---|
| true | any | yes | `true` | yes | yes (if `email_digest=true`) |
| false | true | yes | `false` | no | yes |
| false | false | no | n/a | n/a | n/a |

The decision is **frozen** at write time — toggling `in_app=true` later does NOT retroactively reveal historical digest-only rows. This preserves the "decision captured at write time" semantics from the original design without locking out the email channel.

Reads that target the panel apply `panel_visible = true` as an extra predicate: `listNotifications`, `getUnreadCount`, `streamNotifications` (SSE), and the mutating endpoints (`markRead`, `markAllRead`, `softDeleteNotification`) all filter so a digest-only row is invisible to the bell, can't be marked-read from the panel, and isn't dragged into "mark all read". The digest worker is unchanged — it already filters by `notification_preferences.email_digest = true` and now finds the rows it needs.

### Auto-mark-read on consumption

A notification stays unread until the recipient acts on it. The canonical trigger is **landing on the notification's `link_url`** — at that point the operator has visibly consumed the linked resource and the bell ping is stale.

Implementation:

- The bell hook (mounted in the topbar of every authenticated page) calls `usePathname()` and, on every change, fires `NotificationsService.markReadByLink(client, pathname)`.
- `POST /v1/notifications/mark-read-by-link` marks every unread notification for the current user whose `link_url` matches the body — REGARDLESS of `panel_visible`. A digest-only row (`panel_visible = false`) whose resource the user just visited is "consumed" exactly like a panel row; leaving it unread would feed it back into tomorrow's digest as a stale recap. Idempotent — every navigation hits the endpoint; the common case is `marked: 0`.
- The body's `linkUrl` shares the same shape constraint as the DB CHECK on `notifications.link_url` (`^/(?!/).*$`) so a malformed payload 400s before reaching the SQL.
- The hook soft-fails on any error (5xx / 401 mid-navigation): the bell stays in its prior state rather than burst a global error banner on every page change.

**Contract for new notification types** (also captured in ADR-031 § 4): pick a `link_url` such that landing on it is a meaningful "I have consumed this" signal:

- Resource-scoped events (`donation.received`, `branding.logo_synced`) → resource detail / settings page.
- Index-page events (`bulk_email.queued`, `invitation.created`) → the list view where the new item appears.
- Avoid `link_url`s that are too broad — they collapse unrelated notifications into one auto-read sweep.
- If a future type cannot satisfy the contract, ship it with `link_url = NULL` so the sweep never matches; the panel's explicit "Marquer comme lu" button is the only way to clear it.

### Identifier discipline (`users.id` vs `keycloak_id`)

Every column on `notifications` / `notification_preferences` that points at a person is `user_id uuid REFERENCES users(id)` — the application's row UUID, NOT the Keycloak `sub`. Real seeds (and the impersonation playground tenant) keep `users.id ≠ users.keycloak_id`, so confusing the two is silent: queries return zero rows, fanout writes zero recipients, and the bell never lights up.

Two consequences for any code that touches the notification graph:

1. **Routes filter by `request.auth.userRowId`, not `request.auth.userId`.** The auth plugin resolves the row UUID alongside the active-row check (ADR-021) and surfaces it as `userRowId`. The route returns 401 when it's null — super-admins (no `users` row) and DB-blip fail-opens both surface that way.
2. **Outbox payloads that the fanout reads as a recipient (e.g. `requestedBy` for `campaign.postal_export_requested`, `communication.bulk_email_requested`) carry the resolved row UUID, not the JWT subject.** Audit attribution for "who requested this" is captured separately by the audit plugin from `request.auth.userId` — payload `requestedBy` is fanout-targeting only.

The same discipline applies to other FK columns pointing at `users.id` across the schema (`tenant_flag_overrides.set_by`, `bulk_email_jobs.requested_by`, `campaign_postal_exports.requested_by`, …): write the row UUID, never the JWT `sub`.

## 4. Permissions matrix

| Endpoint | Method | Flag | Guard | Notes |
|---|---|---|---|---|
| `/v1/notifications` | GET | `communication.notifications_center` | `requireAuth` | Lists caller's own rows. RLS isolates tenant; service filters `user_id = currentUserId`. |
| `/v1/notifications/unread-count` | GET | `communication.notifications_center` | `requireAuth` | Caller-scoped count. |
| `/v1/notifications/:id/read` | PATCH | `communication.notifications_center` | `requireAuth` | Caller-scoped — 404 if not owned. Idempotent. |
| `/v1/notifications/read-all` | POST | `communication.notifications_center` | `requireAuth` | Idempotent — returns count of rows touched. |
| `/v1/notifications/mark-read-by-link` | POST | `communication.notifications_center` | `requireAuth` | Body `{ linkUrl }`. Marks every panel-visible unread row matching the link as read. Auto-fired by the bell hook on every pathname change. |
| `/v1/notifications/:id` | DELETE | `communication.notifications_center` | `requireAuth` | Soft-delete (sets `deleted_at`). |
| `/v1/notifications/stream` | GET | `communication.notifications_center` | `requireAuth` | SSE. Heartbeat every 25 s. Resumes from `Last-Event-ID`. |
| `/v1/notification-preferences` | GET | `communication.notifications_center` | `requireAuth` | Returns the closed set (every registered type), defaults merged in. |
| `/v1/notification-preferences/:type` | PATCH | `communication.notifications_center` | `requireAuth` | Upsert (idempotent). Body `{ inApp, emailDigest }`. |
| `/profile/notifications` | GET | `communication.notifications_center` | requireAuth (SSR) | 404 if flag off. |

Flag gate runs FIRST per the canonical `[requireFlag, requireRole]` pattern from `docs/18-feature-flags.md` § 6.1 — a scanner can't enumerate gated routes by their auth requirement.

## 5. GDPR posture

The notification surface is per-user data; GDPR Articles 5, 15, 17 apply.

- **PII in the row body**: NEVER. `params` carries opaque identifiers (donation id, campaign id, invitation id) and non-sensitive counters (`amountCents`, `currency`). Donor names / emails are dereferenced client-side via `link_url`. A constituent deleted via GDPR DSR (Epic #21 / ADR-021) does NOT leave their name frozen in the panel — the link target itself filters on `deleted_at IS NULL`.
- **Soft-delete**: a panel "Dismiss" sets `deleted_at`; the row stays for the audit chain. A future GDPR DSR purge step (out of scope for this Epic — tracked under ADR-021 cleanup) hard-deletes notifications whose `user_id` matches the erased account.
- **User-rights export** (Art. 15): the existing `/v1/users/me` GDPR-snapshot export adds `notifications` + `notification_preferences` to its payload in a follow-up — tracked alongside ADR-021's universal export schema.
- **User-rights erasure** (Art. 17): on user purge the FK `users.id → notifications.user_id` is `ON DELETE SET NULL`, so historical rows are orphaned (kept for tenant audit) but no longer attribute to an identified person. `notification_preferences.user_id → users.id` is `ON DELETE CASCADE` since the preferences are personal-only and don't carry audit value once the user is gone.
- **Cross-tenant isolation**: RLS keys `notifications.org_id` to `app.current_organization_id` (FORCE ROW LEVEL SECURITY). The worker writes under `withWorkerContext(tenantId)`; the API reads under `withTenantContext(orgId)`. A cross-tenant SELECT returns zero rows even with a hand-crafted SQL injection — the partial unique on the GUC is the durable boundary.
- **Audit log**: every PATCH / POST / DELETE on `/v1/notifications*` is auto-recorded by the existing `plugins/audit.ts` plugin (impersonation context propagates per `project_impersonation_two_modes` — both the impersonator and the impersonated user land in the audit row).

## 6. Implementation phases

The Epic ships in one PR:

1. **Step 0 — feature flag**: register `communication.notifications_center` in the shared registry; seed via migration. Every new route + worker job pickup + web surface gates on it.
2. **Phase 1 — schema + outbox subscriber + REST API**: migration 0055 creates the two tables + RLS + indices. Worker's `fanoutNotifications` runs alongside `routeDomainEvent` for every outbox event. API exposes list / unread-count / mark-read / mark-all-read / soft-delete.
3. **Phase 2 — topbar bell + panel**: `NotificationsBell` mounts when the SSR-resolved flag is on; `NotificationsPanel` matches the GLO-004 mockup (filter chips, accent bars, mark-all-read, click-through). Polling fallback at 30 s.
4. **Phase 3 — preferences page**: `/profile/notifications` (every authenticated role; not `/settings/*` which is org-admin only). Optimistic upsert.
5. **Phase 4 — SSE delivery**: `/v1/notifications/stream` (`text/event-stream`). EventSource client swaps polling for SSE; falls back automatically on error. `Last-Event-ID` resume.
6. **Phase 5 — email digest (opt-in)**: BullMQ recurring job at 09:00 UTC daily. Reads each tenant's opted-in users + their unread rows since the cursor, sends one digest per recipient via `defaultEmailSender`. Templates are minimal text/HTML — per-user locale + per-tenant DKIM are explicit follow-ups (see § 7).
7. **Phase 6 — docs**: this doc + ADR-031 + flow diagram + CLAUDE.md file-tree update.

## 7. Out of scope

The Epic explicitly does NOT ship:

- **Push notifications (mobile / browser Web Push)** — opt-in re-engagement is non-trivial; deferred.
- **SMS notifications** — `ff.sms_notifications` placeholder exists in `docs/04-business-capabilities.md`; not in this Epic.
- **AI aggregation** ("3 similar grant-deadline alerts grouped") — listed as future enhancement in GLO-004 spec.
- **Cross-org notifications for super-admins** — Back Office is the cross-org surface; the panel is tenant-scoped.
- **Per-tenant DKIM / sending domain for the email digest** — depends on Epic #279.
- **Per-user locale resolution for the email digest body** — current digest renders English. Follow-up wires the same i18n keys the panel uses.
- **HTML templating with the tenant logo in the email digest** — same dependency on Epic #279 / tenant branding propagation to email.
- **`LISTEN/NOTIFY` for the SSE generator's internal loop** — current polling at 5 s is acceptable for the shipped MVP; ADR-031 § Revisit if calls out the migration trigger.
- **Re-routing notifications when a user is offboarded** — handled by tenant-offboarding flow, not this Epic.
- **Archive management UI** — the column exists; surfacing it is a small follow-up.

## 8. Acceptance — per Epic #363

- [x] `communication.notifications_center` flag registered + seeded; every new route protected with `requireFlag(...)` as the first preHandler; every dependent UI surface and worker job pickup gated; off-state QA done.
- [x] Spike ADR merged ([`docs/adrs/adr-031`](adrs/adr-031-notifications-delivery-and-fanout.md)).
- [x] `notifications` table + RLS shipped, with passing isolation tests.
- [x] At least 5 event producers wired (donation, invitation × 2, branding activation, postal export, bulk email).
- [x] Topbar bell + panel match the mockup.
- [x] Preferences page live.
- [x] SSE delivery shipped + polling fallback in place.
- [x] `docs/27-notifications.md` + ERD + permissions matrix + GDPR section (this file).
- [x] CLAUDE.md updated.
