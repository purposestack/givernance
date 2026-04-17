# 21 — Authentication & Single Sign-On (SSO)

> **Status**: Approved (Phase 1)
> **Related**: `06-security-compliance.md`, `15-infra-adr.md`, `19-impersonation.md`
> **Context**: PR #73 (Sprint 4: Auth UI & App Shell)

## 1. Overview
Givernance uses **OpenID Connect (OIDC)** via **Keycloak** as the sole authentication mechanism. Local username/password forms have been intentionally discarded in favor of a 100% SSO-driven flow. This centralizes identity management, simplifies GDPR compliance (password handling), and enables enterprise-grade features (MFA, SAML federation) out of the box.

## 2. Authentication Flow (Next.js & Fastify)

1. **Login Trigger**: The user visits `https://givernance.app/login` and clicks the "SSO Login" button.
2. **Redirect to Keycloak**: The Next.js API route `GET /api/auth/login` generates:
   - `state` (Anti-CSRF)
   - `nonce` (OIDC replay protection)
   - `code_challenge` / `code_verifier` (PKCE S256 to prevent code interception)
   These are stored in temporary `httpOnly` cookies (5-minute TTL). The user is redirected to the Keycloak Authorization endpoint.
3. **Keycloak Auth**: The user authenticates (via Google Workspace, Microsoft Entra, or Keycloak local DB).
4. **Callback**: Keycloak redirects to `GET /api/auth/callback` with an authorization `code`.
5. **Token Exchange**: Next.js exchanges the `code` + `code_verifier` for an Access Token (JWT) via backend server-to-server call.
6. **Session Establishment**: 
   - The JWT is saved in the `givernance_jwt` cookie (`httpOnly`, `Secure`, `SameSite=Strict`).
   - A secondary `csrf-token` cookie (non-httpOnly) is set for the browser to read.
   - The user is redirected to `/dashboard`.

## 3. Sign-Out Flow

The sidebar footer hosts a `LogOut` icon button that triggers the sign-out. It submits a form POST (not `fetch`) so the browser can natively follow the cross-origin redirect to Keycloak's end-session endpoint.

1. `POST /api/auth/logout` — clears both the `givernance_jwt` and `givernance_id_token` cookies, then 303-redirects to Keycloak's end-session URL with:
   - `client_id=givernance-web`
   - `post_logout_redirect_uri=${APP_URL}/login`
   - `id_token_hint=<the id_token>` — suppresses Keycloak's "Do you want to log out?" confirmation page
2. Keycloak ends the server session and redirects the browser to `/login`.

> **Why `id_token_hint` matters**: without it, Keycloak shows an HTML confirmation screen. The ID token is stored in `givernance_id_token` at callback time specifically to avoid that extra click.

> **Why `post.logout.redirect.uris` must be registered**: Keycloak 21+ requires the client to explicitly allow the `post_logout_redirect_uri`. The attribute is set in `infra/keycloak/realm-givernance.json`. Existing containers that already imported the realm need the attribute pushed via the admin API (`--import-realm` skips existing realms).

**Limitation — stateless session**: the JWT is self-contained and verified by signature, so revoking the Keycloak session does NOT invalidate an already-issued access token until its 8h TTL expires. Back-channel logout with a Redis `sid` blocklist is tracked in [#76](https://github.com/purposestack/givernance/issues/76).

## 4. Cookies Set by the Flow

| Cookie | Purpose | httpOnly | SameSite | Lifetime |
|--------|---------|:--------:|:--------:|----------|
| `givernance_jwt` | Access token used by web server components and sent to the API | Yes | Strict | 8h |
| `givernance_id_token` | ID token kept only to pass as `id_token_hint` on logout | Yes | Strict | 8h |
| `csrf-token` | Double-submit CSRF token (readable by JS via `<meta>`) | No | Strict | session |
| `oidc_state`, `oidc_code_verifier`, `oidc_nonce` | Short-lived OIDC flow state | Yes | Lax | 5 min |

## 5. Local Development Setup

### Required environment variables
Copy `.env.example` to `.env` — the OIDC-relevant vars are:

```
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=givernance
KEYCLOAK_CLIENT_ID=givernance-web
KEYCLOAK_CLIENT_SECRET=ci-test-secret-do-not-use-in-production
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
API_URL=http://localhost:4000
```

### Default Tenant fallback
`KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_CLIENT_SECRET` have sane defaults in [`packages/web/src/lib/auth/keycloak.ts`](../packages/web/src/lib/auth/keycloak.ts), so the app runs even if those are omitted.

### Docker + Keycloak realm seed
`docker compose up -d` starts Keycloak, which auto-imports `infra/keycloak/realm-givernance.json` on first startup. The seed provides:

- Realm `givernance` with brute-force protection enabled
- Client `givernance-web` with PKCE-compatible flow and the `post.logout.redirect.uris` attribute
- A single pre-provisioned user: **`admin@givernance.org` / `admin`** with the `super_admin` realm role

### Local login credentials
- **App URL**: http://localhost:3000 → redirects to `/dashboard`, then to `/login` when signed out
- **User**: `admin@givernance.org`
- **Password**: `admin`

*(Keycloak's master admin console is separate: `admin`/`admin` at http://localhost:8080.)*

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `curl http://localhost:8080/realms/givernance` returns 404 | Keycloak running but realm not imported (realm JSON added after container started) | `docker compose up -d --force-recreate keycloak` |
| `?error=token_exchange_failed` on callback | Wrong `KEYCLOAK_CLIENT_SECRET` or realm misconfigured | Check the API console — `console.error("Token Exchange Failed: ...")` logs the Keycloak response |
| Clicking logout leaves you signed in on Keycloak | Old session from before the `post.logout.redirect.uris` attribute was added | Push the attribute via admin API or clear cookies for `localhost:8080` |
| Clicking login after logout auto-redirects without Keycloak prompt | Keycloak session cookie still alive | Expected once Keycloak session is ended via logout; if not, see row above |
