## ADR-021: User Lifecycle — Soft-delete in App, Hard-delete in Keycloak, Anonymisation for GDPR

**Status**: Accepted (PR #185 round-3, issue #161)
**Related**: ADR-016 (tenant onboarding & KC organizations), ADR-017 (one logical DB per tool), `docs/06-security-compliance.md` (GDPR), `docs/19-impersonation.md` (RFC 8693 actor)

### Context

Phase 1 shipped a hard-delete for `users` rows (`DELETE FROM users WHERE id = :id`) without touching Keycloak. Two real-world consequences surfaced in PR #185:

1. **Re-invite is broken.** An org_admin removes a member, then re-invites the same email. The new invitation accept tries `kcAdmin.createUser`, which 409s because the email is still bound to the old Keycloak user (we never deleted it). Accept rejects with `team_invite.kc_user_exists` → generic 410. The user appears un-rejoinable.
2. **App and KC drift silently.** The application thinks the user is gone; Keycloak still has them with a valid `org_id` attribute. Tokens issued before the delete remain valid until expiry. Refresh tokens still mint fresh access tokens. The user can keep authenticating against the API for as long as KC accepts their tokens, even though the application has "removed" them.

Beyond re-invite and security, the existing hard-delete is **inconsistent with the rest of the schema** — `constituents` already uses soft-delete (`deleted_at`), audit_logs is immutable + 7-year-retained, donations cascade from constituents. `users` was the only mutable identity record without an audit trail of removal.

GDPR Right to Erasure (Art. 17) is a separate concern that hard-delete addresses crudely: nuking the row breaks foreign keys (audit_logs.userId, donations.created_by, invitation.invited_by, etc.) and destroys the ability to reconstruct accountability for events the deleted user authored. Anonymisation — replacing PII fields with deterministic placeholders while keeping IDs and FKs intact — is the better fit for the codebase's audit-first posture.

### Decision

User lifecycle in Givernance follows three distinct operations, each with a different semantic and a different mutation pattern. **Keycloak is the source of truth for identity; the application's `users` row mirrors KC state and adds tenant-membership context.**

| Operation | Application (`users` row) | Keycloak | When |
|---|---|---|---|
| **Remove member** (admin clicks "Remove") | **Soft-delete**: `deleted_at = now()`, `keycloak_id = NULL` | **Delete** the realm user (`DELETE /admin/realms/{realm}/users/{id}`) | Org_admin removes a teammate; user no longer works at the tenant |
| **Rejoin** (re-invite + accept) | **Restore**: `deleted_at = NULL`, refresh `first_name` / `last_name` / `role`, write fresh `keycloak_id` | **Create** a new realm user (fresh `sub`) | The same email is re-invited and accepts |
| **GDPR erasure** (data subject request) | **Anonymise**: replace `first_name`, `last_name`, `email` with deterministic placeholders; set `anonymised_at = now()` (separate column from `deleted_at`); KEEP `id`, `org_id`, FKs, audit chain | **Delete** the realm user | Data subject invokes Art. 17; out of scope for this PR but the schema supports it |

#### 1. Remove member — soft-delete + KC hard-delete

The intent is "this person no longer works at this tenant". Both halves of the identity must reflect that:

- **Application**: `UPDATE users SET deleted_at = now(), keycloak_id = NULL WHERE id = :id`. The row is preserved so audit_logs.user_id and other FKs stay valid; the user's history (donations they recorded, invitations they sent) remains attributable. `keycloak_id = NULL` because the row no longer points at any live KC user — anything that previously joined on it should now miss.
- **Keycloak**: `kcAdmin.deleteUser(keycloakId)` deletes the realm user entirely. This:
  - Frees the email for re-invite (no more 409 on `createUser`).
  - Invalidates the user's refresh tokens (KC drops them with the user).
  - Leaves a brief window (≤ access-token TTL, typically 5–15 min) where access tokens issued *before* deletion are still cryptographically valid but reference a non-existent KC user. The application's auth boundary is responsible for closing this window; see §"Token revocation" below.
- **Listing endpoints filter `WHERE deleted_at IS NULL`**: `GET /v1/users`, `GET /v1/users/me`, `PATCH /v1/users/:id`, the auth-context user lookup. A soft-deleted user is invisible to all routes except those that explicitly opt in to historical lookups (the rejoin path and audit-trail readers).
- **Unique constraint becomes partial**: drop `UNIQUE (org_id, email)`, replace with `UNIQUE (org_id, email) WHERE deleted_at IS NULL`. The same email can be re-invited cleanly even though a soft-deleted row exists.

#### 2. Rejoin — clear `deleted_at` + fresh KC bind

When a removed member is re-invited and accepts, the invitation-accept flow:

1. Looks up the existing row by `(org_id, lower(email))` **without** filtering `deleted_at` (the recovery query needs to see soft-deleted rows).
2. If found and `deleted_at IS NOT NULL`: it's a **rejoin**. The KC user is gone (deleted at remove-time), so we always run `kcAdmin.createUser` for a fresh `sub`. Then UPDATE the existing row in place (preserves the UUID and FK chain): clear `deleted_at`, write the new `keycloak_id`, refresh `first_name` / `last_name` / `role` from the invitation.
3. If found and `deleted_at IS NULL`: existing pre-soft-delete recovery path (the row's KC user exists; reset password and re-attach attributes).
4. If not found: fresh `createUser` + `INSERT`.

The same application UUID is preserved across rejoin, but the `keycloak_id` (the JWT `sub`) is new. Audit rows that reference the old `sub` keep referencing it; new audit rows reference the new `sub`. RBAC forensics can join via the application UUID (resourceId on profile-update audits, userId on action audits before the rebind) — the bridge is the `users.id` column, not `users.keycloak_id`.

#### 3. GDPR erasure — anonymisation, not hard-delete

A data subject's Right to Erasure is satisfied by **anonymising** the row, not deleting it:

- Set `first_name = 'Anonymised'`, `last_name = '<row-id-suffix>'`, `email = '<row-id>@anonymised.invalid'`.
- Set `anonymised_at = now()` (separate from `deleted_at` so the two states compose).
- KC: `deleteUser` (the realm user is fully erased).
- Audit_logs that reference this user_id remain intact — the FK is preserved, and the PII is gone.
- Reverse-engineering the original identity from the anonymised row is impossible (the placeholders are deterministic but carry no input from the original PII).

Anonymisation is a separate flow from "remove member" and is out of scope for PR #185, but the schema accommodates it (the `anonymised_at` column lands as a follow-up alongside the GDPR erasure worker).

### Auth boundary — closing the post-delete access window

Deleting a KC user invalidates refresh tokens immediately (KC drops them with the user) but does **not** invalidate already-issued access tokens — they remain cryptographically valid until expiry because the application's auth plugin can't hit `/userinfo` per request (perf-sensitive) and the JWT signature still verifies. Without compensation, a removed member retains app access for the full access-token TTL window (typically 5–15 min).

This ADR closes the window with **two explicit auth-plugin checks**, layered on top of the existing JTI blocklist:

1. **User-ID blocklist (Redis)** — when a user is removed (or otherwise revoked), the auth plugin writes `auth:user-blocklist:<keycloakId>` to Redis with TTL ≥ max access-token lifetime. Every subsequent request consults the blocklist alongside the existing JTI check; a hit returns 401 + `authDenial: { reason: "user_revoked" }`. This piggybacks on the same Redis path the impersonation `switch-org` flow already uses (`packages/api/src/modules/session/service.ts`), keeping the auth plugin's hot path to two `GET` calls.

2. **Tenant claim sanity check** — every authenticated request must satisfy ONE of:
   - `realm_access.roles` includes `super_admin` (platform-level access; no org binding by design), OR
   - `org_id` is present on the JWT AND an active `users` row exists for `(keycloak_id = sub, org_id = org_id, deleted_at IS NULL)`.

   A JWT whose `(sub, org_id)` doesn't resolve to an active row is rejected at the auth plugin layer with 401 + `authDenial: { reason: "no_active_membership" }`. This closes the symptom reported in PR #185 round-3: a deleted user with a still-valid JWT could reach `/dashboard` because no route checked that the JWT's `(sub, org_id)` actually corresponded to a member of any tenant.

   A JWT with no `org_id` claim is already rejected one layer up by `verifyKeycloakJwt` (every Keycloak token in this realm carries `org_id`; super_admin tokens reuse a placeholder tenant id since the realm mapper can't omit the claim). The auth plugin therefore never observes a `decoded.org_id === undefined` case at runtime — the verifier surfaces it as a generic "Authentication required" 401 from `requireAuth`. Pinning that surfaced behaviour (rather than adding a granular `no_org_claim` discriminator that would be dead code) keeps the boundary contract honest.

The active-row lookup is cached in Redis at `auth:active-user:<sub>:<orgId>` with a short TTL (default 30 s) to bound the per-request DB cost. The cache key is invalidated on user soft-delete and on rejoin so revocations propagate within the cache TTL window. Combined with the user-ID blocklist (which has zero-second propagation), the effective window for a removed user retaining access is **0 seconds** for the blocklist path and **≤ cache TTL** for the active-row path — both well under the access-token TTL.

`super_admin` requests skip both the active-row lookup and the user-ID blocklist (super-admins are platform principals; they don't have a `users` row in any tenant by design).

### Why not per-request DB lookup without cache

A naive `SELECT FROM users WHERE keycloak_id = :sub AND deleted_at IS NULL` on every authenticated request adds one DB round-trip to every API call. At Phase 1 traffic (< 100 RPS per tenant) this is acceptable but wasteful. The cache + blocklist split keeps the hot path on Redis, which already sits in the auth plugin's call graph for the JTI check.

### Why not rely solely on KC's `/userinfo`

Hitting KC on every request adds ~30 ms per call (network + KC DB lookup) and creates a hard dependency on KC's availability for every authenticated request. The user-ID blocklist gives the same security property (revocation visible immediately) without the latency or coupling.

### Rationale

- **Soft-delete preserves the audit trail.** Hard-deleting the row breaks `audit_logs.user_id`, `invitations.invited_by_id`, and any FK that stored the user's UUID. The codebase's stance is "audit is 7+ years, accountability is per-row" (ADR-016 §Schema additions, `docs/17-log-management.md` §7). Soft-delete is the only pattern compatible with this stance.
- **KC hard-delete is symmetric with the user's mental model.** "I removed Bob" should mean Bob is gone — from the tenant, from Keycloak, from being able to log in. Anything else is surprising. The `keycloak_id = NULL` after delete makes the half-state explicit on the row.
- **Rejoin reuses the application UUID, not the KC sub.** The application UUID is the stable identity for everything in the application's data model. The KC sub is the JWT subject — it's tied to the KC user lifecycle, which we explicitly recreate on rejoin. Mixing them ("preserve the sub on rejoin") would force us to recreate a KC user with the same `sub`, which KC doesn't support cleanly.
- **Anonymisation > hard-delete for GDPR.** GDPR allows pseudonymisation as a satisfactory erasure when full hard-delete would compromise legitimate interests (audit, legal hold, fraud prevention). Givernance's audit_logs retention is one such legitimate interest.
- **Partial unique index over distinct table.** A `users_archive` table would split the row across two locations and require migration on rejoin. Partial unique on `(org_id, email) WHERE deleted_at IS NULL` keeps the row in one place and lets the database enforce the uniqueness invariant.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| Hard-delete the application row + KC user | Simple, no schema change | Breaks audit FK chain; loses accountability; rejoin requires restoring from logs | Rejected — incompatible with audit-first posture |
| Soft-delete the row but keep the KC user | Reversible at KC layer | Email stays bound to a stale KC user; re-invite fails (the symptom that motivated this ADR); user can still authenticate until token + refresh expiry | Rejected — KC must mirror app state |
| Disable the KC user (`enabled: false`) instead of deleting | Reversible if user is re-hired with the same KC sub | Email still bound (re-invite still fails); zombie user accumulates in the realm; no actual data minimisation | Rejected — fails the re-invite test, no real upside |
| `users_archive` table for soft-deleted rows | Active table stays small | Migration cost on rejoin; FK retargeting; two-table reconciliation in audit queries | Rejected — partial unique on the live table is simpler |
| Hard-delete on GDPR erasure | "Truly gone" | Cascades break audit; blocks legal-hold; courts have ruled hard-delete isn't strictly required when pseudonymisation suffices | Rejected — anonymisation matches industry practice |

### Consequences

- **Schema additions** — migration adds `users.deleted_at` (timestamptz, nullable). Drops `users_org_id_email_uniq`; replaces with partial unique `users_org_id_email_active_uniq (org_id, email) WHERE deleted_at IS NULL`. The `anonymised_at` column lands with the GDPR erasure worker (separate PR).
- **Route changes** — `DELETE /v1/users/:id` becomes soft-delete + KC delete. `GET /v1/users`, `GET /v1/users/me`, `PATCH /v1/users/:id` filter `WHERE deleted_at IS NULL`.
- **Invitation accept** — recovery branch handles three cases (active rebind, soft-delete rejoin, fresh) instead of two; rejoin always runs `createUser` (the old KC user is gone).
- **Auth boundary** — `packages/api/src/plugins/auth.ts` gains two checks executed before `request.auth` is set:
  1. User-ID blocklist (`auth:user-blocklist:<sub>`) consulted alongside the existing JTI blocklist. Hit → 401 with `authDenial: { reason: "user_revoked" }`.
  2. Active-row resolution: tenant users (non-super_admin) must resolve to a row matching `(keycloak_id, org_id, deleted_at IS NULL)`. Cached at `auth:active-user:<sub>:<orgId>` with 30 s TTL. Miss → 401 with `authDenial: { reason: "no_active_membership" }`. JWTs with no `org_id` are already rejected one layer up by `verifyKeycloakJwt` and surface as a generic 401 from `requireAuth` — no additional discriminator is wired in the auth plugin since that branch is unreachable at runtime.
- **KC admin client** — gains `deleteUser(userId)` (idempotent on 404). `removeMemberFromOrganization` deferred until a use case for "remove from this org but keep KC user" emerges.
- **Session service** — gains `blocklistUser(keycloakId, ttlSeconds)`, `isUserBlocklisted(keycloakId)`, and `invalidateActiveUserCache(keycloakId, orgId)`. Same Redis instance as the JTI blocklist.
- **Tests** — (a) full delete + re-invite + accept loop succeeds (the symptom motivating this ADR); (b) soft-delete + GET /v1/users excludes the row; (c) rejoin preserves the application UUID; (d) auth plugin rejects a JWT for a soft-deleted user with `authDenial.reason === "user_revoked"`; (e) auth plugin rejects a JWT for a non-existent `(sub, org_id)` with `authDenial.reason === "no_active_membership"`; (f) `verifyKeycloakJwt` rejects a JWT with no `org_id` (surfaces as the generic "Authentication required" 401).

### Revisit criteria

- If the access-token-TTL window proves operationally unacceptable (e.g. a fired employee retaining access for > 15 min becomes a customer-reported risk), implement the JTI blocklist on user delete and amend this ADR.
- If audit_logs retention requirements or GDPR enforcement pushes toward hard-delete in specific regions, evaluate region-scoped erasure flows (full hard-delete + audit-log scrubbing) as a separate ADR.
- If KC's Organizations feature gains "remove from org without deleting user" semantics that benefit cross-tenant users (one person at multiple Givernance tenants), revisit the KC hard-delete decision.

---

*This document is curated to show only active architectural decisions. Superseded decisions are removed for clarity.*

## ADR 12: Staging Low-Cost / Guérilla via Kamal

**Date:** 2026-04-27
**Status:** Accepted

### Context
L'environnement de production suit une architecture distribuée et résiliente, s'appuyant sur des services managés (Neon/Postgres, Upstash/Redis, S3/AWS) avec des coûts incompressibles associés. Pour la phase de développement et de validation (Staging), répliquer cette architecture à l'identique engendrerait des coûts disproportionnés par rapport à l'usage réel (tests de QA, validation des PR, environnements éphémères).

Nous avons besoin d'un environnement de staging fonctionnel, automatisé et ISO-fonctionnel avec la production, mais avec une empreinte financière drastiquement réduite.

### Decision
**Mise en place d'une architecture "Staging Low-Cost / Guérilla" sur une VM unique, déployée via Kamal.**

- **Outil de Déploiement :** Utilisation de Kamal (anciennement MRSK) pour orchestrer les conteneurs Docker via SSH.
- **Infrastructure :** Une seule machine virtuelle (VPS) abordable (ex: Hetzner, DigitalOcean) au lieu d'un cluster ou de services managés.
- **Registry :** GitHub Container Registry (GHCR) pour stocker les images de manière transparente avec GitHub Actions.
- **Accessoires Locaux (Conteneurs) :** Au lieu des services managés, nous faisons tourner des conteneurs "accessories" via Kamal sur la même machine :
  - `postgres` (Base de données)
  - `redis` (Cache et queues)
  - `minio` (Stockage objet compatible S3)
  - `keycloak` (Gestion de l'identité)

### Consequences
- **Avantages :** 
  - Réduction drastique des coûts d'infrastructure pour le staging.
  - Déploiement très rapide et reproductible via GitHub Actions (déclencheur `workflow_dispatch` et `push` sur la branche `staging`).
  - L'intégration CI/CD passe les bonnes variables d'environnement (`STAGING_VPS_IP`) dynamiquement.
- **Inconvénients :** 
  - L'environnement de staging dévie de la production au niveau de la gestion de l'état (Single Point of Failure, pas de haute disponibilité, stockage sur volume local plutôt que S3 natif).
  - Nécessite la configuration de MinIO au lieu de S3 direct.
  - Les données ne sont pas garanties en cas de perte de la VM (mais acceptable pour du staging).

### Revisit Criteria
Si les tests de charge en staging nécessitent plus de ressources, ou si les différences d'infrastructure (MinIO vs AWS S3, Postgres local vs Neon) causent trop de faux-positifs dans les tests de validation, nous reconsidérerons l'utilisation partielle de services managés.
