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

## 3. MVP Local Development & Default Tenant

To facilitate rapid onboarding and testing during the MVP phase without requiring complex Keycloak realm configuration for every developer, a **Default Tenant** fallback is hardcoded into the OIDC flow.

- **Default Realm**: `givernance`
- **Default Client ID**: `givernance-web`
- **Fallback Logic**: If `NEXT_PUBLIC_KEYCLOAK_REALM` is not provided in the `.env` file, the Next.js frontend defaults to the `givernance` realm.
- **Keycloak Docker Container**: The local `docker-compose.yml` automatically imports a realm configuration file (`infra/keycloak/realm-givernance.json`) on startup, pre-provisioning the `givernance` realm and an admin user.

### Local Credentials
When clicking "SSO Login" in local development (`http://localhost:3000`), you will be redirected to the local Keycloak container (`http://localhost:8080`).
- **Username**: `admin@givernance.org`
- **Password**: `admin`

*(Note: Keycloak's master admin console remains accessible with `admin`/`admin` if you need to inspect the realm settings).*
