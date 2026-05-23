## ADR-031: In-app notification centre — delivery mechanism + event-source fanout

**Status**: Proposed (Epic #363, 2026-05-16)
**Related**: ADR-011 (4-layer frontend), ADR-012 (shadcn/ui + design tokens), ADR-013 (frontend type boundary), ADR-021 (soft-delete universal), ADR-022 (platform admins disjoint), `docs/14-screen-inventory.md` GLO-004, `docs/17-log-management.md`, `docs/18-feature-flags.md`, `docs/27-notifications.md`

### Context

[Epic #363](https://github.com/purposestack/givernance/issues/363) ships the in-app notification centre specified by GLO-004 in `docs/14-screen-inventory.md`: bell icon in the topbar, side panel with filter chips, per-user preferences, and real-time delivery. Today the codebase has the producer side (outbox events for donations, invitations, branding activation, postal exports, bulk emails) but no consumer surface for end users — campaign imports finish without an in-app signal, grant deadlines pass silently, donations arrive without alerting anyone.

Three architectural decisions need a commit before the implementation can land:

1. **Delivery mechanism** — how does a fresh notification reach the donor / operator browser?
   - SSE (`text/event-stream`) — simple, unidirectional, behind any HTTP proxy.
   - WebSocket — bidirectional, adds infra (sticky sessions, custom proxy config on Kamal + Scaleway LB).
   - Polling only — cheapest to ship, worst UX.
2. **Event source** — who produces a notification row?
   - (a) Producer-side double-write: every domain mutation in the API service ALSO writes a notification row in the same transaction.
   - (b) Consumer-side fanout: a worker subscribes to the outbox and writes notification rows downstream of every event it cares about.
   - (c) Hybrid.
3. **Data model** — frozen string body vs. `(title_key, body_key, params)` i18n tuple; tenant-scoped vs. recipient-scoped; soft-delete vs. hard-delete.

Decisions must be justified against:

- **Cost of a brand-new tenant** that hasn't yet flipped the feature on — must be zero (no idle SSE connections, no orphan worker queues).
- **Per-tenant locale** — a French org_admin sees French notifications even when the worker that wrote the row was processing an English-session request.
- **GDPR posture** — notification rows must not freeze constituent PII in their body. A constituent deleted via GDPR DSR must not leave their name in the panel.
- **Existing infrastructure** — the codebase already has BullMQ + outbox + RLS + feature-flag scaffolding. The Epic should *lean on* these, not duplicate them.

### Decision

#### 1. Delivery mechanism: **SSE with polling fallback**

`GET /v1/notifications/stream` (`text/event-stream`) is the primary transport. The frontend hook (`useNotificationsLive`) opens an `EventSource` with `withCredentials: true` so the session cookie rides along; the server sends an initial `event: ready` ping followed by `event: notification` frames as new rows arrive. Heartbeat comment frames (`: heartbeat\n\n`) every 25 s keep idle proxies from closing the connection.

Reconnect is handled by the browser's native `EventSource` retry logic. The server reads the `Last-Event-ID` header on reconnect — we set it to the most-recently-delivered row's `created_at` ISO so reconnect resumes from the exact position without replaying older rows.

**Polling fallback** activates in three cases:
- `EventSource` is unavailable (jsdom test environments, very old browsers).
- The SSE connection emits an `error` event (proxy rejecting `text/event-stream`, CSP block, network blip beyond the browser's retry).
- The flag-gate or another upstream layer 404s the route.

The fallback hits `GET /v1/notifications/unread-count` every 30 s when the tab is focused (no work when backgrounded). Polling and SSE coexist safely — the panel dedupes rows by id, so an overlap window doesn't show duplicates.

**Why not WebSocket**: the notification surface is fundamentally one-way (server → client). WebSocket would require sticky sessions across Kamal's load balancer + Scaleway's LB, a separate protocol handshake, and a custom Fastify plugin. SSE is one Fastify route, plain HTTP, no infra changes.

**Why not polling-only**: a 30 s round-trip on an active operator session feels stale ("did the donation come through?" → wait, refresh). SSE is the right primary; polling is the safety net.

#### 2. Event source: **consumer-side fanout (option b)** via the existing outbox subscriber

The worker's `processDomainEvent` (`packages/worker/src/worker.ts`) already runs on every outbox row. The Epic adds **one new step at the top of that handler**: a feature-flag-gated `fanoutNotifications(event)` call that translates the event into one or more notification rows.

`planFanout(event)` is a pure function that returns a list of `(notificationType, recipientFilter, titleKey, bodyKey, params, linkUrl)` entries. The worker:
1. Reads the flag (`isFlagEnabled(COMMUNICATION_NOTIFICATIONS_CENTER)`). Short-circuits with zero DB work if off.
2. For each entry, resolves recipients (`all_org_admins` or `specific_user`).
3. Honours `notification_preferences.in_app = false` at write time — opted-out users never get a row.
4. Inserts inside `withWorkerContext(tenantId)` so RLS isolates the tenant.
5. Logs and continues on any failure — fanout is best-effort UX, never blocks the existing routing decision (donation → receipt PDF, branding → activation, etc.).

**Why not producer-side double-write**: the producer (the API service handling `POST /v1/donations`) doesn't know who the recipients are. "Notify every org_admin of the tenant" requires a `SELECT … FROM users WHERE org_id = ? AND role = 'org_admin'` — fine to run server-side, but the same query duplicates everywhere. Centralising it in the worker keeps the producer code clean and lets us add recipient rules (per-user opt-in / opt-out, role-based routing) without touching every service.

**Why not "subscribe to the audit log" instead of the outbox**: the audit log is request-scoped (synchronous, inside the route's transaction) and admin-facing — it doesn't propagate to BullMQ. The outbox is already the source of truth for "things happened that downstream consumers might care about." Adding a second consumer (notifications) alongside the existing first (receipts, postal exports, branding activation) is the obvious place.

**Why a soft-fail, not a retry**: if the notification row write fails, retrying the whole outbox event would also retry the receipt PDF generation, the postal-export ZIP, etc. — non-idempotent side-effects that we'd rather not run twice for the sake of a UX row. A future Phase moves fanout to a dedicated retry-bearing queue if real-world flake demands it.

#### 3. Data model

`notifications` is **recipient-scoped** (`user_id`), not just tenant-scoped. Every read filters `notifications.user_id = currentUserId`; a tenant member can never see another member's notifications even within the same tenant. The DB constraint is enforced at the service layer, not via a second RLS policy — Postgres RLS keys on a single GUC, and `app.current_user_id` would be a second GUC to wire through the API + worker. The user filter is cheap (indexed) and the service code is a stable boundary.

**i18n via `(title_key, body_key, params)`** instead of a frozen `text` body. The web panel resolves keys against the consumer's locale via `next-intl`; the email digest does the same. Two consequences:
- A French org_admin sees French even when the donation creator was on an English session.
- `params` is a `jsonb` map of opaque identifiers + non-sensitive counters (e.g. `{donationId, amountCents, currency}`). Donor names / emails are NEVER in `params` — the panel dereferences them via the `link_url` page, which itself goes through tenant RLS. GDPR DSR-deleted constituents do NOT leave names frozen in the panel.

**Soft-delete universal** (per `feedback_soft_delete_universal` / ADR-021): a panel "delete" sets `deleted_at`; the row stays for audit + GDPR DSR replay. Every read filters `deleted_at IS NULL`.

**`type` is `varchar(64)`** with a CHECK constraint on shape (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`), NOT a Postgres enum. Adding a new type ("campaign_postal_export_completed") is a code change in `NOTIFICATION_TYPE_VALUES` + producer wiring — never a migration. The shared registry (`packages/shared/src/constants/notifications.ts`) is the source of truth.

#### 4. Auto-mark-read on consumption — per-type contract

A notification stays unread until the recipient acts on it. The acceptable trigger is **landing on the notification's `link_url`** — at that point the operator has visibly consumed the linked resource and the bell ping is stale. Every notification type therefore ships with a `link_url` that satisfies this contract: navigating there means "I have now seen what you wanted to tell me about".

Concretely:

- The web shell POSTs `/v1/notifications/mark-read-by-link` on every pathname change. The endpoint marks every panel-visible unread notification for the current user whose `link_url` matches the path. Idempotent — fires on every navigation, returns 0 in the common case (no match).
- The bell hook owns this side-effect because it's already mounted in the topbar of every authenticated page and already holds the `markRead*` mutators. No per-page wiring needed.
- Digest-only rows (`panel_visible = false`) are NOT affected — the bell never showed them and `markReadByLink` filters by `panel_visible = true`. Their read state is irrelevant to the panel.

**Contract for new notification types**: pick a `link_url` such that landing there is a meaningful "I have consumed this" signal. Concretely:

- Resource-scoped events (`donation.received`, `branding.logo_synced`) link to the resource's detail / settings page. Landing means the operator has looked at the receipt / new logo / new invitation.
- Index-page events (`bulk_email.queued`, `invitation.created`) link to the list view where the new item appears. Landing means the operator has at least scanned the list.
- **Avoid `link_url`s that are too broad** (e.g. linking every team event to `/settings`) — they collapse unrelated notifications into one auto-read sweep. When in doubt, prefer the more specific resource page.

If a future type genuinely cannot satisfy the "landing = consumption" contract (e.g. a "your scheduled job will fire in 5 minutes" preview), it should ship with `link_url = NULL` so the auto-mark-read sweep never matches it, and rely on the explicit "Marquer comme lu" button in the panel.

### Consequences

**Pro**:
- Zero infra delta: SSE is a single Fastify route, fanout sits alongside existing outbox routing, no new BullMQ queue beyond the daily digest.
- Adding a notification type is a 3-line code change (registry + producer wiring), no migration.
- Per-tenant locale flows automatically.
- Soft-delete keeps audit + DSR replay trivial.
- A tenant with the flag off is indistinguishable from one before the Epic shipped — no idle connections, no orphan rows, no UI flash.

**Con**:
- SSE through Cloudflare requires `X-Accel-Buffering: no` to disable proxy buffering — already set in the route, but a future proxy swap needs the same hint.
- Consumer-side fanout means the recipient set is resolved at fanout time. If an org_admin role is granted between the donation event and the fanout (unusual, but possible), they don't get the notification. The audit log still records the grant; this is acceptable for a UX surface.
- `LISTEN/NOTIFY` would be cheaper than polling for the SSE generator's internal loop. We poll every 5 s instead — a known follow-up (see § Revisit if).
- The email digest renders an English-only body in this Epic. Per-user locale resolution there is a small but explicit follow-up.

### Rejected alternatives

| # | Alternative | Rejected because |
|---|---|---|
| 1 | WebSocket transport | Adds sticky sessions, custom Kamal/LB config, separate protocol handshake. SSE covers the unidirectional use case at one route's cost. |
| 2 | Polling only | A 30 s round-trip on an active operator session feels stale. SSE is the right primary, polling is the safety net. |
| 3 | Producer-side double-write | Duplicates recipient resolution across every domain service; future role-based routing changes would touch every call site. |
| 4 | Subscribe to `audit_logs` instead of outbox | Audit log is request-scoped + admin-facing; doesn't propagate to BullMQ. Outbox is the existing async-event boundary. |
| 5 | Hard-delete on panel "Dismiss" | Conflicts with ADR-021 universal soft-delete + breaks GDPR DSR replay (audit must be able to enumerate every notification a user has ever seen). |
| 6 | Frozen `text` body, no i18n keys | French user can't see French unless the producer was on a French session. Doesn't compose with per-user locale (ADR-011 / issue #153). |
| 7 | Postgres enum for `type` | Every new notification type requires `ALTER TYPE` migration. `varchar` + CHECK constraint + shared registry gives the same type-safety without the migration cost. |
| 8 | Cross-org notifications for super-admins | Out of scope per Epic § 4. Super-admins use the Back Office for cross-org visibility; the panel is a tenant-scoped UX. |
| 9 | A dedicated BullMQ queue for fanout (retried, DLQ-backed) | Premature given the soft-fail posture. Today's fanout runs inline in `processDomainEvent`; a future Phase splits it out if real-world flake demands retries. |

### Revisit if

- Polling SSE generator becomes a measurable PG cost (the 5 s `WHERE created_at > $cursor` polling loop is per-stream — at >500 concurrent streams per replica it adds up).
- A tenant requests an email-only mode (no in-app surface). The current model assumes `in_app = false` is the suppression knob; an explicit "email only, no row written at all" would need a second flag.
- WebSocket needs justified by a new bidirectional flow (e.g. operator-to-operator chat) — at that point we'd reuse the WebSocket boundary for notifications too.
- The notification volume per tenant exceeds the daily digest's "scan all unread since cursor" pattern (>10 k rows per user per day). At that scale the digest job needs to switch to a cursor-paginated batch rather than a single-tenant SELECT.
