## ADR-029: Keycloak session revocation — back-channel `sid` blocklist, 5-min access tokens, silent refresh

**Status**: Accepted (issue #76, 2026-05-12)
**Related**: ADR-016 (Keycloak Organizations + jti blocklist for switch-org), ADR-021 (user-ID blocklist after soft-delete), `docs/21-authentication-sso.md` §4.1–§4.2, issue #76, PR #360

### Context

Until PR #360, Givernance access tokens were self-contained JWTs with an 8-hour TTL. That had two consequences:

1. An admin invoking "Sign out all sessions" in Keycloak ended the upstream SSO session **but did nothing** to the access tokens already in browser cookies — they remained valid for up to 8 hours.
2. A sibling-device logout (a user clicking "Sign out" on phone, returning to laptop where the cookie is still hot) likewise had no effect on the laptop session.

The existing revocation primitives didn't cover this case:

- `session_blocklist:<jti>` (ADR-016) is set by `POST /v1/session/switch-org` to revoke a *single token*. After a silent refresh, the new token has a new `jti` — blocklisting the old one revokes that exact token but not its successors.
- `auth:user-blocklist:<sub>` (ADR-021) is set on soft-delete and covers all of a user's tokens — but the trigger is application-side soft-delete, not an upstream Keycloak session-end.

OIDC Back-Channel Logout 1.0 is the spec mechanism: Keycloak POSTs a signed `logout_token` to a webhook on session end. The app blocklists the OIDC `sid` claim, which stays stable across access-token refreshes for the same SSO session, so blocklisting it invalidates the current token *and every refresh of it*.

Four interlocking decisions had to be made:

1. **What to blocklist on** — `sid` vs `jti`?
2. **TTL of the blocklist entry** — must outlive the longest still-valid access token.
3. **Where the webhook lives** — Fastify API or Next.js web?
4. **CSRF policy on the silent-refresh endpoint** — double-submit or omit?

### Decision

**1. Blocklist on `sid`, not `jti` (or `sub`).**

`sid` is stable across access-token refreshes for the same Keycloak SSO session — the spec property that makes back-channel logout work. `jti` rotates on every refresh, so blocklisting it only invalidates the token in flight; the next refresh sails through. `sub` would be too broad — it revokes the user across every active SSO session of theirs (including ones we didn't intend to end, e.g. a CI service account that shares the `sub`). Blocklist key: `auth:kc-sid-blocklist:<sid>`.

**2. TTL = 10 minutes (2× access-token lifespan).**

With `access.token.lifespan=300` (5 min — see decision 5 below), any access token Keycloak might still emit for the revoked session expires within 5 minutes. The 10-min blocklist TTL gives 2× headroom for clock skew between Keycloak and the API, then the key drops automatically. Operators changing `access.token.lifespan` upward should also bump `KEYCLOAK_SID_BLOCKLIST_DEFAULT_TTL_S` to match.

**3. Endpoint on the Fastify API, not the Next.js web.**

The OIDC spec's literal expectation is that the webhook lives on the OIDC client (the web). We chose the API instead. Reasons:

- The API already owns the Redis connection (`packages/api/src/lib/redis.ts`) — the web does not. Adding Redis to the web runtime for a single endpoint is infrastructure cost we don't want to amortise.
- The API already owns the realm JWKS verifier (`packages/api/src/lib/keycloak-jwt.ts`) — same key set as access-token verification.
- The API already owns the auth plugin that reads the blocklist on every authenticated request.
- The back-channel POST is server-to-server (Keycloak → API), not browser-mediated. No OIDC-client property of the web is load-bearing for the URL's home.

The realm attribute carries the absolute URL, so Keycloak doesn't care whether it hits `/api/auth/...` (web) or `/v1/session/...` (API). The trade-off is that operators rotating the URL must remember it points at the API; documented in the staging runbook and the doc.

**4. No CSRF on `/api/auth/refresh`.**

The refresh cookie is httpOnly + `SameSite=Strict`. The CSRF cookie is also `SameSite=Strict`. A cross-site POST to `/api/auth/refresh` is already blocked at the browser layer. Same-site CSRF (a malicious script on the same origin) already has worse capabilities — and the only side effect of a CSRF-tricked refresh is rotating the victim's own tokens. The response JSON does NOT leak the new tokens (they're in `Set-Cookie` headers the JS can't read).

Adding a double-submit check would block legitimate cross-tab refreshes (different tab, can't share the in-memory token) without adding security. We rotate the CSRF cookie alongside the JWT to close the secondary "XSS once → CSRF forever within session" window (PR #360 review Security m6).

**5. Shorten `access.token.lifespan` to 5 minutes.**

The blocklist window is bounded by the access-token TTL. With the previous 8h TTL, a revoked session's tokens stay rejectable for 8h — keeping the Redis set large. 5 minutes is the smallest TTL that doesn't make every API call into a refresh-token exchange (the realm's recommended floor). Silent refresh in the AuthProvider rotates before expiry so the user never sees the boundary.

### Consequences

**Wins**:

- Admin sign-out-all and sibling-device logout propagate within ≤ 5 minutes (access-token TTL window) instead of 8 hours.
- Compromised-token blast radius shrinks from 8h to 5 min for any session that's been actively revoked.
- The Redis blocklist stays small — entries auto-expire 10 min after a revocation signal.

**Costs**:

- Every authenticated API request now does an extra Redis GET (`isKeycloakSessionBlocklisted`). The auth plugin already does a `jti` GET; adding `sid` doubles that. Fail-closed on Redis blip means a Redis outage hard-401s every request — same posture as the existing blocklists.
- Silent refresh is now load-bearing. A refresh failure ≠ "user is gone" — it could mean transient Keycloak unavailability. The AuthProvider retries with a budget (5 attempts at 30s) before clearing local state.
- Per-environment `backchannel.logout.url` is a configuration footgun: `scripts/keycloak-sync-realm.sh` will overwrite a manual override back to the dev value. Mitigated by a runbook (`docs/runbooks/keycloak-backchannel-logout-cutover.md`) and an explicit warning in doc 21 §4.1.

### Rejected alternatives

**Blocklist on `jti` of the logout token (replay defence).** The OIDC spec recommends storing the logout-token `jti` to detect replays. We chose to skip this. The blocklist write is idempotent (re-blocklisting an already-blocklisted `sid` re-sets the same key with the same TTL — no behaviour change). The worst a replay can do is keep the blocklist entry alive ~5 minutes longer than necessary. Adding `jti` dedup adds a second Redis call per webhook for no observable benefit; revisit if a real-world attacker emerges who exploits this.

**Put the webhook on the Next.js web.** Considered (matches the OIDC spec's typical expectation) and rejected — see decision 3 above.

**Use `sub` instead of `sid`.** Considered and rejected — too broad (revokes the user across every active SSO session of theirs, including ones we didn't mean to end). `sub` is already on the user-ID blocklist (ADR-021) which is a *different* lifecycle (soft-delete, not SSO logout).

**Make the silent-refresh endpoint CSRF-protected.** Considered and rejected — see decision 4 above.

**Coordinate refresh across tabs via BroadcastChannel.** Considered and rejected for v1. Each open tab schedules its own refresh; concurrent refreshes produce one winner + one `invalid_grant` failure; the losing tab catches the 401 and bounces to `/login`. The blast radius is one extra round-trip + one redirect for a multi-tab user during exactly the 30s window when Keycloak's refresh-token rotation flagged the older token. Acceptable trade-off; revisit if it becomes a real-world UX complaint.

### Revisit when

- `access.token.lifespan` changes (the 10-min blocklist TTL is tuned to 2× of 5 min)
- Keycloak's back-channel-logout protocol updates beyond OIDC Back-Channel Logout 1.0
- We add a second OIDC client to the realm (the verifier's `aud` check would need to accept multiple audiences)
- Multi-tab refresh races become a measurable UX issue (then introduce a BroadcastChannel coordinator)
- A real-world attacker exploits logout-token replay (then add `jti` dedup)
