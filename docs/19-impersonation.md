# 19 — Impersonation Strategy

> **Status**: Spike / Analysis — Phase 1 implementation target
> **Owner**: Impersonation Engineer agent (`.claude/agents/impersonation-engineer.md`)
> **Related**: `02-reference-architecture.md`, `03-data-model.md`, `06-security-compliance.md`, `15-infra-adr.md`, `17-log-management.md`
> **Closes**: #6

## 1. Goals

The impersonation system must allow a platform admin (`super_admin`) to:

1. **Act as any user** on any tenant — with exactly the same permissions, RBAC, feature flags, and RLS data scope as the real user
2. **Leave a full audit trail** — every action is double-attributed: the impersonated user (data integrity) and the real admin (accountability)
3. **Be time-limited and step-up authenticated** — impersonation requires TOTP re-verification and a mandatory reason; sessions expire after 2 hours
4. **Preserve user trust** — the impersonated user can optionally be notified; every impersonation session is exportable as part of GDPR Art. 15 data

## 2. Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                          super_admin browser                           │
│                                                                        │
│   1. POST /admin/impersonation { targetUserId, reason, stepUpCode }   │
│      ← impersonation token (JWT, max 2h, httpOnly cookie)             │
│                                                                        │
│   2. All subsequent API calls use impersonation token                 │
│      ← impersonation banner rendered in root layout (non-dismissable) │
│                                                                        │
│   3. DELETE /admin/impersonation/:sessionId  (or auto-expire after 2h)│
└──────────────────────────┬────────────────────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────────────────────┐
│                      Fastify 5 API                                     │
│                                                                        │
│  Auth middleware:                                                      │
│   - Decode JWT → extract sub (impersonated user), act.sub (admin),    │
│     imp_session_id                                                     │
│   - Validate session is still active in Redis                         │
│   - Set RLS context from impersonated user's org_id                   │
│                                                                        │
│  Audit plugin:                                                         │
│   - buildAuditEntry() → actor_user_id = sub (impersonated user)       │
│                          impersonator_id = act.sub (admin UUID)        │
│                          impersonation_session_id = imp_session_id     │
└──────────────────────────┬────────────────────────────────────────────┘
                           │
          ┌────────────────┴──────────────────┐
          │                                   │
┌─────────▼────────┐                ┌─────────▼────────┐
│  Redis (session  │                │   PostgreSQL     │
│  TTL store)      │                │   audit_logs +   │
│  SaaS: Scaleway  │                │   impersonation_ │
│  Managed Redis   │                │   sessions       │
└──────────────────┘                └──────────────────┘
```

## 3. Token Design

### Recommended: Keycloak Token Exchange (RFC 8693)

Keycloak 24 supports OAuth2 Token Exchange. The super_admin exchanges their own valid access token for a short-lived token representing the target user, with the standard RFC 8693 `act` claim injected via a custom Script Mapper:

```http
POST /realms/givernance/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<super_admin_access_token>
&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&requested_token_type=urn:ietf:params:oauth:token-type:access_token
&requested_subject=<target_user_keycloak_id>
```

**Keycloak setup required:**
- Enable `Token Exchange` feature flag in Keycloak realm settings (`Features → token-exchange`)
- Create a realm policy granting the `impersonation` role only to the `givernance-api` service account (not all clients)
- Inject the RFC 8693 `act` claim via a Script Mapper on the `givernance-api` client (detects `token-exchange` grant type, injects `act: { sub: <original_subject> }`)
- **Note**: Token Exchange is an admin-only feature in Keycloak 24 — requires `realm-management` client role on the service account

### Fallback: Application-layer impersonation JWT

If Keycloak Token Exchange is not configured in Phase 1:

1. `POST /admin/impersonation` validated by the API
2. API issues a signed short-lived JWT containing the target user's claims + `act` claim + impersonation metadata
3. JWT stored by reference in Redis: `impersonation:{sessionId}` with TTL = 2h
4. All subsequent requests validated against Redis (allows instant revocation)

**Migration path**: Start with the application-layer approach in Phase 1; migrate to Keycloak Token Exchange in Phase 2. The token shape is identical either way.

### JWT claims (RFC 8693-compliant)

> **RFC 8693 compliance note**: RFC 8693 Section 4.1 distinguishes **impersonation** (admin identity erased, no `act` claim) from **delegation** (both identities preserved via the `act` claim). Givernance requires double-attribution — both identities must survive in the token for audit. This is semantically **delegation**, so we use the standard `act` claim to carry the actor (admin) identity. Application-specific claims (`imp_session_id`, `imp_reason`) remain as custom top-level claims — the RFC does not define equivalents.
>
> **Keycloak limitation**: Keycloak 24 (and even 26.2) does not produce the `act` claim natively — `actor_token`/`actor_token_type` parameters are not supported (keycloak/keycloak#12076, open since 2022). Phase 1 (app-layer JWT) injects `act` directly. Phase 2 uses a custom Keycloak Script Mapper (~50 lines JS) to inject `act` during token exchange — no custom Java SPI required.

```json
{
  "sub": "<impersonated_user_uuid>",
  "org_id": "<impersonated_tenant_uuid>",
  "role": "<impersonated_user_role>",
  "act": {
    "sub": "<super_admin_uuid>"
  },
  "imp_session_id": "<session_uuid_v7>",
  "imp_reason": "Support ticket #1234 — user cannot access donations",
  "iat": 1712000000,
  "exp": 1712007200
}
```

Key design decisions:
- `sub` is the **impersonated user** — RBAC and RLS behave as if the real user is logged in
- `act.sub` carries the **admin's identity** per RFC 8693 Section 4.1 — the presence of the `act` claim is the canonical signal that a token is a delegation token
- `imp_session_id` and `imp_reason` are Givernance-specific claims (no RFC equivalent) — shortened from `impersonation_*` to minimize JWT size
- `exp` is capped at 2h from `iat` — tokens are not renewable, a new INITIATE is required
- Token is delivered as an `httpOnly` cookie (same as normal session tokens — never `localStorage`)
- Middleware detects delegation via `decoded.act?.sub` (not a custom claim name) — any RFC 8693-aware tool (OPA policies, SIEM parsers, OAuth2 proxies) will correctly identify these as delegation tokens

## 4. Session Lifecycle

### State machine

```
INITIATE ──(step-up OK, reason provided)──► ACTIVE   (endedAt IS NULL, expiresAt > now())
ACTIVE   ──(admin ends)──────────────────► ENDED    (endedAt SET, endReason='manual')
ACTIVE   ──(TTL reached)─────────────────► EXPIRED  (expiresAt <= now(), endedAt IS NULL)
ACTIVE   ──(platform revoke)─────────────► REVOKED  (endedAt SET, endReason='revoked')
```

> Status is **derived** from `endedAt` / `expiresAt` / `endReason` — no `status` column stored.
> This preserves the append-only guarantee: rows are INSERT + one final UPDATE to set endedAt.

### `impersonation_sessions` table

```typescript
export const impersonationSessions = pgTable('impersonation_sessions', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  impersonatorId: uuid('impersonator_id').notNull().references(() => users.id),
  targetUserId: uuid('target_user_id').notNull().references(() => users.id),
  targetOrgId: uuid('target_org_id').notNull().references(() => tenants.id),
  reason: text('reason').notNull(),
  // status is DERIVED (never stored): active = endedAt IS NULL AND expiresAt > now()
  //                                       ended  = endedAt IS NOT NULL
  //                                       expired = expiresAt <= now() AND endedAt IS NULL
  //                                       revoked = endReason = 'revoked'
  // Do NOT add a status column — it would require UPDATE and break append-only guarantee
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  endReason: text('end_reason'),              // 'manual' | 'expired' | 'revoked' | null (still active)
  ipHash: text('ip_hash'),                   // SHA-256 truncated (not raw INET — aligned with doc-17)
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // Indexes for common admin queries
  byImpersonator: index('idx_imp_sessions_impersonator').on(t.impersonatorId),
  byTarget: index('idx_imp_sessions_target').on(t.targetUserId),
  byOrg: index('idx_imp_sessions_org').on(t.targetOrgId),
  byExpiry: index('idx_imp_sessions_expiry').on(t.expiresAt), // for cleanup job
}));
```

**Append-only rule**: The `status` column must never be updated via a direct `UPDATE`. Use dedicated columns (`ended_at`, `end_reason`) and reflect status in the application layer. This preserves the append-only nature of audit records and makes DB-level tampering easier to detect.

## 5. Audit Trail: Double-Attribution

### `audit_logs` schema additions

Two nullable columns are added to the existing `audit_log` table (doc-03 uses singular — align during Phase 1 schema reconciliation):

```sql
ALTER TABLE audit_log
  ADD COLUMN impersonator_id           UUID REFERENCES users(id),
  ADD COLUMN impersonation_session_id  UUID REFERENCES impersonation_sessions(id);
```

- For normal actions: both columns are `NULL`
- For impersonation actions: both columns are populated

### What a double-attributed audit entry looks like

```json
{
  "id": "01950f3a-...",
  "orgId": "tenant-uuid",
  "actorUserId": "impersonated-user-uuid",
  "impersonatorId": "super-admin-uuid",
  "impersonationSessionId": "session-uuid",
  "actorRole": "fundraising_manager",
  "action": "donation.created",
  "resourceType": "donation",
  "resourceId": "donation-uuid",
  "changes": { "after": { "amount": 150, "currency": "EUR" } },
  "metadata": {
    "correlationId": "...",
    "ipHash": "sha256-truncated",
    "userAgent": "Mozilla/5.0 (truncated)"
  },
  "occurredAt": "2026-04-02T09:12:00Z"
}
```

### Audit events catalog

| Event | `action` | Level | `impersonator_id` |
|---|---|---|---|
| Impersonation started | `impersonation.started` | `warn` | `impersonator_id` = admin UUID; `actor_user_id` = target user UUID (not yet acting, just session open) |
| Action during impersonation | `<domain_action>` e.g. `donation.created` | `info` | Yes |
| Impersonation ended | `impersonation.ended_by_admin` | `info` | Yes |
| Impersonation expired | `impersonation.expired` | `info` | Yes |
| Impersonation revoked | `impersonation.revoked` | `warn` | Yes |
| Denied attempt | `impersonation.denied` | `error` | N/A (admin token logged separately) |

## 6. Permission Isolation

Impersonation must NOT elevate the impersonated session beyond the target user's normal permissions.

| Layer | Behaviour during impersonation | How enforced |
|---|---|---|
| RBAC | Target user's role only (e.g. `fundraising_manager`) | JWT `role` claim = target user's role |
| RLS | Target user's `org_id` only | `SET LOCAL app.current_org_id` from JWT `org_id` claim |
| Feature flags | Target tenant's overrides | Redis cache keyed by `tenantId` from JWT |
| MFA-protected routes | Step-up at session start covers MFA requirement | Configurable per operation |
| super_admin-only routes | **Blocked** — admin temporarily loses super_admin access | JWT `role` = impersonated user's role, not super_admin |

**Critical**: A super_admin impersonating a `fundraising_manager` must NOT be able to access super_admin routes during that session. The impersonation token replaces — it does not stack on top of — the admin's token.

## 7. Frontend: Impersonation Banner

A persistent, non-dismissable banner is rendered in the Next.js root layout whenever an impersonation token is active:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ⚠️  Impersonating: Marie Dupont · Maison du Cœur                          │
│     Reason: Support ticket #1234 — user cannot access donations tab        │
│     Session expires in  1h 47m                         [End session →]     │
└────────────────────────────────────────────────────────────────────────────┘
```

**Requirements:**
- Amber/orange background — visually distinct from all other UI states
- Renders server-side (SSR-safe via JWT claim inspection in root layout)
- Shows: impersonated user name + org, reason, remaining time (client-side countdown), end button
- Non-dismissable — cannot be hidden by page or component code
- "End session" → `DELETE /admin/impersonation/:sessionId` → redirects to super_admin dashboard
- Banner is **never shown to the impersonated user** — it is only visible to the admin's browser session

## 8. Step-Up Authentication

Initiating an impersonation session requires re-verifying the admin's TOTP code:

```http
POST /admin/impersonation
Authorization: Bearer <super_admin_access_token>
Content-Type: application/json

{
  "targetUserId": "user-uuid",
  "reason": "Support ticket #1234 — user cannot access the donations tab after plan upgrade",
  "stepUpCode": "123456"
}
```

**Validation rules:**
- `reason` is mandatory, minimum 20 characters (must be meaningful, not "test")
- `stepUpCode` is mandatory — TOTP verified against the admin's MFA device
- Rate limit: max 10 impersonation session starts per admin per 24h (Redis counter)
- A failed `stepUpCode` → `impersonation.denied` audit event (no session created)
- Brute-force detection: 3 failed attempts in 10 minutes → temporary lockout + security alert

## 9. Administration API

```
POST   /admin/impersonation
         Start a new session. Body: { targetUserId, reason, stepUpCode }
         Guards: RBAC.SUPER_ADMIN + TOTP step-up
         Returns: { sessionId, token, expiresAt }

GET    /admin/impersonation
         List all active impersonation sessions (platform-wide)
         Guards: RBAC.SUPER_ADMIN

GET    /admin/impersonation/:sessionId
         Session details including all audit events
         Guards: RBAC.SUPER_ADMIN

DELETE /admin/impersonation/:sessionId
         End a specific session
         Guards: RBAC.SUPER_ADMIN

DELETE /admin/impersonation/user/:targetUserId
         Revoke all active sessions for a specific user (emergency)
         Guards: RBAC.SUPER_ADMIN

GET    /admin/impersonation/:sessionId/audit
         All audit_log entries for this session
         Guards: RBAC.SUPER_ADMIN
```

All mutating endpoints: audit logged (even if the action is the admin ending their own session).

## 10. GDPR Considerations

| Concern | Decision |
|---|---|
| Legal basis for impersonation | Legitimate interest (Art. 6(1)(f)) — support and platform integrity; document in the privacy policy |
| `reason` field | Mandatory, non-blank — creates an auditable paper trail of why the admin accessed the account |
| Art. 15 data export | `impersonation_sessions` rows included in both: the impersonated user's export (they have the right to know their account was accessed) AND the admin's activity export |
| `act.sub` (impersonator) visible in user's audit export | Yes — transparency is required. The user can see "a platform admin accessed your account on <date> for reason <reason>" |
| User notification | Platform-configurable (default: off). When enabled: post-session email to impersonated user. Notification is sent **after** the session ends, not during (to avoid tipping off a user being investigated for abuse). |
| Right to erasure | `impersonation_sessions` rows are **audit records exempt from erasure** (same principle as `audit_logs`). Document this exception explicitly in `docs/06-security-compliance.md`. |
| Retention | 7–10 years (aligned with `audit_logs` retention policy from doc-17) |
| IP address | Stored as SHA-256 truncated hash — not raw INET (consistent with doc-17 §7.2 audit log approach) |
| DPA/DPIA | If impersonation allows access to special-category data (case notes, health data), a DPIA entry is recommended. Add to the risk register (`docs/09-risk-register.md`). |

## 11. Cross-Agent Rules

### For MVP Engineer

- `POST /admin/impersonation` must require `RBAC.SUPER_ADMIN` + TOTP step-up before issuing any token
- The delegation token must include the RFC 8693 `act` claim: `act: { sub: <admin_uuid> }` — detect delegation via `decoded.act?.sub`, not a custom claim
- Every Drizzle audit write helper must accept optional `impersonatorId` (extracted from `act.sub`) and `impersonationSessionId` (from `imp_session_id`) parameters and pass them to the `audit_logs` insert
- BullMQ `job.data._meta` must include `impersonatorId` and `impersonationSessionId` when jobs are enqueued during an impersonation session — workers must propagate these to their own audit writes
- The impersonation token is delivered as `httpOnly` cookie — never exposed to JavaScript
- Reason field minimum length: 20 characters — enforced with a TypeBox validator in `packages/shared/validators`

### For QA Engineer

- Test: impersonated session cannot access resources outside the target tenant (RLS still fully enforced)
- Test: impersonated session cannot call super_admin-only routes (JWT `role` claim = impersonated user's role)
- Test: every write during impersonation produces an `audit_logs` row with both `actor_user_id` and `impersonator_id` (from `act.sub`) non-null
- Test: session expires after 2h TTL and subsequent requests return 401
- Test: `POST /admin/impersonation` with `reason` shorter than 20 chars returns 400
- Test: `POST /admin/impersonation` with wrong TOTP returns 401 + `impersonation.denied` audit event
- Test: non-super_admin calling `POST /admin/impersonation` returns 403
- Test: impersonation banner renders in root layout during impersonation session
- Test: `DELETE /admin/impersonation/:sessionId` invalidates the Redis key and subsequent requests return 401

### For Security Architect

- Impersonation token must be signed with the same key as standard JWTs — no weaker signature curve or key length
- `impersonation_sessions` rows must be append-only — no `UPDATE` on `status`; use `ended_at` + `end_reason`
- Redis key format: `impersonation:{sessionId}` — session UUID prevents key collisions
- Rate limit: max 10 impersonation starts per admin per 24h (Redis counter: `impersonation:ratelimit:{adminId}`, TTL 24h)
- Security alert if `impersonation.denied` > 3 in 10 minutes for the same admin
- Brute-force lockout: after 5 consecutive failed TOTP attempts on impersonation start, lock the admin account for 15 minutes

### For Data Architect

- Add `impersonator_id UUID` and `impersonation_session_id UUID` nullable columns to `audit_logs` in `packages/shared/src/schema/`
- `impersonation_sessions` is a platform table — no tenant-scoped RLS needed
- Include `impersonation_sessions` rows in GDPR Art. 15 export for both impersonated user and admin
- Add exemption note to erasure flow documentation: `impersonation_sessions` rows cannot be erased (audit record integrity)
- Partition `impersonation_sessions` by `started_at` if volume is expected to be high

### For Log Analyst

- `impersonation.started` and `impersonation.revoked` must be logged at `warn` level with `audit: true`
- All log lines during an impersonation session must include both `userId` (impersonated, from `sub`) and `impersonatorId` (from `act.sub`) fields
- Add `body.stepUpCode` and `body.step_up_code` to the Pino redact paths — TOTP codes must never appear in logs
- Add `impersonation.*` events to the audit events catalog in `docs/17-log-management.md`
- Log the impersonation session ID as a structured field (`impersonationSessionId`) for LogQL correlation

### For Feature Flag Engineer

- Flag evaluation during impersonation uses the **impersonated tenant's** overrides — no change needed if Redis cache is keyed by `tenantId` (already correct)
- No feature flag is needed to gate the impersonation feature itself — it is always available to `super_admin`

## 12. Open Questions

- [ ] **Keycloak Token Exchange vs. app-layer JWT**: Which to implement in Phase 1? Proposal: app-layer JWT (simpler), migrate to Keycloak Token Exchange in Phase 2. Decision needed.
- [ ] **User notification**: default off or default on? Proposal: default off (notification may interfere with abuse investigations), configurable per platform policy in org settings.
- [ ] **Notification timing**: if enabled, should the user be notified at session start or at session end? Proposal: session end — avoids alerting the user during an active investigation.
- [ ] **Nested impersonation**: can a super_admin impersonate another super_admin? Proposal: no — block it explicitly (if `targetUser.role === 'super_admin'`, return 400).
- [ ] **Read-only impersonation mode**: should there be an option to impersonate in a read-only mode (no writes allowed)? Useful for UI debugging without risk of accidental data mutation.
- [ ] **DPIA requirement**: does impersonation access to special-category data (case notes, health records) trigger a mandatory DPIA under GDPR Art. 35? Consult DPO.
- [ ] **Concurrent sessions**: should a super_admin be allowed to have multiple simultaneous impersonation sessions? Proposal: max 1 active session per admin at a time.

## 13. Implementation Phases

### Phase 1 (Core impersonation — app-layer JWT)

- [ ] `impersonation_sessions` Drizzle schema in `packages/shared`
- [ ] Add `impersonator_id` + `impersonation_session_id` columns to `audit_logs` schema
- [ ] `POST /admin/impersonation` — TOTP step-up + reason validation + session creation
- [ ] Impersonation middleware in `packages/api/src/lib/auth/impersonation.middleware.ts`
- [ ] Dual-attribution in `buildAuditEntry()` audit plugin
- [ ] Redis session store with 2h TTL
- [ ] `DELETE /admin/impersonation/:sessionId` — end session + Redis invalidation
- [ ] `GET /admin/impersonation` — list active sessions
- [ ] Rate limiting (10 starts per admin per 24h)
- [ ] Frontend `ImpersonationBanner` component in root layout
- [ ] `getImpersonationContext()` SSR utility
- [ ] BullMQ `_meta` propagation for impersonation fields
- [ ] Integration tests (see cross-agent rules for QA Engineer)
- [ ] `impersonation.*` events added to doc-17 audit catalog

### Phase 2 (Keycloak Token Exchange)

- [ ] Enable Token Exchange in Keycloak realm configuration
- [ ] Custom Keycloak Script Mapper to inject RFC 8693 `act` claim (`act: { sub: <original_subject> }`) on `token-exchange` grant type — ~50 lines JS, no custom Java SPI required
- [ ] Pass `imp_session_id` and `imp_reason` as custom request parameters to the Script Mapper
- [ ] Migrate `POST /admin/impersonation` to use Keycloak Token Exchange (token shape is identical — `act` claim already used in Phase 1)
- [ ] Retain Redis session store for instant revocation (Keycloak tokens cannot be instantly revoked)
- [ ] User notification system (configurable per platform policy)
- [ ] Admin impersonation dashboard with session history
- [ ] Monitor keycloak/keycloak#12076 — when native `act` claim support lands, remove the custom Script Mapper
