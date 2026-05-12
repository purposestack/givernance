/** Strict environment validation for the API process — crash early on missing vars */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const LogLevel = Type.Union(
  [
    Type.Literal("fatal"),
    Type.Literal("error"),
    Type.Literal("warn"),
    Type.Literal("info"),
    Type.Literal("debug"),
    Type.Literal("trace"),
    Type.Literal("silent"),
  ],
  { default: "info" },
);

const EnvSchema = Type.Object({
  /** PostgreSQL connection string */
  DATABASE_URL: Type.String({ minLength: 1 }),
  /** PostgreSQL connection string (app role, optional — falls back to DATABASE_URL) */
  DATABASE_URL_APP: Type.Optional(Type.String({ minLength: 1 })),
  /** Redis connection URL */
  REDIS_URL: Type.String({ minLength: 1 }),
  /** S3-compatible endpoint URL */
  S3_ENDPOINT: Type.String({ minLength: 1 }),
  /** S3 access key */
  S3_ACCESS_KEY_ID: Type.String({ minLength: 1 }),
  /** S3 secret key */
  S3_SECRET_ACCESS_KEY: Type.String({ minLength: 1 }),
  /** S3 bucket for receipts */
  S3_RECEIPTS_BUCKET: Type.String({ minLength: 1, default: "receipts" }),
  /** S3 bucket for campaign documents (PDFs and bundled ZIP exports). */
  S3_CAMPAIGNS_BUCKET: Type.String({ minLength: 1, default: "campaigns" }),
  /**
   * S3 bucket for org branding assets — logos, hero images, etc. (Epic
   * #286). Public-read at the bucket level so donor-facing surfaces
   * (Keycloak login template, donation page) can serve directly without
   * a signed-URL hop. Content is content-addressed (`{org}/logo/{id}/
   * {variant}.{ext}`) so a stale CDN edge can't leak across logos.
   */
  S3_BRANDING_BUCKET: Type.String({ minLength: 1, default: "branding" }),
  /** S3 region */
  S3_REGION: Type.String({ minLength: 1, default: "us-east-1" }),
  /**
   * Base URL the Keycloak login template uses to build the
   * `organization.attributes['logo_url']` value (Epic #286 / docs/24).
   * Defaults to `${S3_ENDPOINT}/${S3_BRANDING_BUCKET}` so local dev
   * "just works" against MinIO. Production overrides this with the
   * public CDN base (e.g. `https://cdn.givernance.eu/branding`) so the
   * KC template's HTTPS-only guard accepts the rendered URL.
   */
  KEYCLOAK_LOGO_PUBLIC_URL_BASE: Type.Optional(Type.String({ minLength: 1 })),
  /** Keycloak base URL used to derive issuer (public) */
  KEYCLOAK_URL: Type.String({ minLength: 1, default: "http://localhost:8080" }),
  /** Keycloak internal URL used for server-to-server calls */
  KEYCLOAK_INTERNAL_URL: Type.Optional(Type.String({ minLength: 1 })),
  /** Keycloak realm used to derive issuer and JWKS endpoint */
  KEYCLOAK_REALM: Type.String({ minLength: 1, default: "givernance" }),
  /** Optional explicit issuer override */
  KEYCLOAK_ISSUER: Type.Optional(Type.String({ minLength: 1 })),
  /** Optional explicit JWKS URL override */
  KEYCLOAK_JWKS_URL: Type.Optional(Type.String({ minLength: 1 })),
  /** Keycloak Admin API base URL (defaults to KEYCLOAK_URL). Used by the admin client (ADR-016). */
  KEYCLOAK_ADMIN_URL: Type.Optional(Type.String({ minLength: 1 })),
  /** Service-account client id used for Keycloak Admin API calls. */
  KEYCLOAK_ADMIN_CLIENT_ID: Type.String({ minLength: 1, default: "givernance-admin" }),
  /** Service-account client secret used for Keycloak Admin API calls. */
  KEYCLOAK_ADMIN_CLIENT_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Public-client identifier the web app authenticates as. The back-channel
   * logout endpoint (issue #76 / PR-2) validates the logout token's `aud`
   * against this so a token minted for a different client is rejected.
   */
  KEYCLOAK_CLIENT_ID: Type.String({ minLength: 1, default: "givernance-web" }),
  /** hCaptcha server-side secret used by the public signup flow (ADR-016 / issue #108). */
  HCAPTCHA_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  /** Explicit override for CAPTCHA enforcement — `disabled` fails open, `prod` fails closed. */
  CAPTCHA_MODE: Type.Optional(Type.Union([Type.Literal("disabled"), Type.Literal("prod")])),
  /** HTTP port */
  PORT: Type.Number({ default: 4000 }),
  /** HTTP bind address */
  HOST: Type.String({ minLength: 1, default: "0.0.0.0" }),
  /** App URL — used as CORS origin and cookie domain */
  APP_URL: Type.String({ minLength: 1, default: "http://localhost:3000" }),
  /** Log level */
  LOG_LEVEL: LogLevel,
  /** NATS WebSocket URL */
  NATS_URL: Type.String({ default: "ws://localhost:4222" }),
  /** Stripe secret key (sk_test_... or sk_live_...) */
  STRIPE_SECRET_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** Stripe webhook endpoint secret (whsec_...) */
  STRIPE_WEBHOOK_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  /** ExchangeRate-API key used for currency conversion refreshes */
  EXCHANGE_RATE_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Symmetric secret used to sign the app-layer impersonation JWT (HS256).
   * The impersonation token is short-lived (≤2h) and scoped to a single
   * support session — using a separate secret from the realm's RS256 keys
   * lets us key-rotate impersonation independently and keeps the blast
   * radius of a leaked secret bounded to existing-session abuse.
   * Required in production; auto-generated stub in dev/CI.
   */
  IMPERSONATION_JWT_SECRET: Type.Optional(Type.String({ minLength: 32 })),
  /**
   * When true, POST /admin/impersonation requires the operator's access token
   * to carry `acr >= 2` (i.e. a recent MFA-backed Keycloak login). Defaults
   * to false in dev/CI where MFA is not configured. Production should set
   * `IMPERSONATION_REQUIRE_ACR_2=true`.
   */
  IMPERSONATION_REQUIRE_ACR_2: Type.Boolean({ default: false }),
  /**
   * When true, the API issues impersonation tokens via Keycloak Token
   * Exchange (RFC 8693) instead of the app-layer HS256 path. Both flows
   * produce the same JWT shape (sub/act/imp_*), but the Keycloak path
   * defers signing/issuance to the realm and keeps audit trail in
   * Keycloak's event log. Defaults false; flip on once the realm has the
   * `impersonation-act-mapper.js` Script Mapper deployed.
   */
  IMPERSONATION_USE_KEYCLOAK_EXCHANGE: Type.Boolean({ default: false }),
  /**
   * TTL (seconds) for delegation sessions. Default 7200 = 2h. The route
   * caps at 14400 (4h) regardless of this value to bound exposure.
   */
  IMPERSONATION_DELEGATION_TTL_SECONDS: Type.Number({ default: 7200 }),
  /**
   * TTL (seconds) for pure-impersonation sessions. Default 1800 = 30m —
   * shorter than delegation because the use case is bug-reproduction, not
   * configuration. Capped at 3600 (1h) by the route.
   */
  IMPERSONATION_IMPERSONATION_TTL_SECONDS: Type.Number({ default: 1800 }),
});

export type ApiEnv = Static<typeof EnvSchema>;

const value = Value.Default(EnvSchema, Value.Convert(EnvSchema, { ...process.env }));

if (!Value.Check(EnvSchema, value)) {
  const errors = [...Value.Errors(EnvSchema, value)];
  const formatted = errors.map((e) => `  ${e.path.slice(1)}: ${e.message}`).join("\n");
  console.error(`[api] Missing or invalid environment variables:\n${formatted}`);
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && !value.DATABASE_URL_APP) {
  console.error("[api] DATABASE_URL_APP is strictly required in production for RLS isolation.");
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && !value.KEYCLOAK_ADMIN_CLIENT_SECRET) {
  console.error(
    "[api] KEYCLOAK_ADMIN_CLIENT_SECRET is strictly required in production for tenant onboarding (ADR-016 / issue #107).",
  );
  process.exit(1);
}

if (process.env.NODE_ENV === "production" && !value.IMPERSONATION_JWT_SECRET) {
  console.error(
    "[api] IMPERSONATION_JWT_SECRET is strictly required in production — without it the support-session API can't sign impersonation tokens (issue #24).",
  );
  process.exit(1);
}

// Extracted as a pure function so the contract is unit-testable without
// having to spawn a Node child process (multi-agent review API-2,
// PR #251). The boot-time invocation below stays inline so a misconfig
// still fails fast at startup; the test in
// `packages/api/src/lib/env-asserts.test.ts` exercises this function
// directly with synthesised env shapes.
export function assertImpersonationStepUpRequired(input: {
  nodeEnv: string | undefined;
  requireAcr2: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.nodeEnv === "production" && !input.requireAcr2) {
    return {
      ok: false,
      reason:
        "[api] IMPERSONATION_REQUIRE_ACR_2 must be `true` in production — step-up MFA is the only barrier between a stolen super-admin cookie and an arbitrary impersonation session (issue #24).",
    };
  }
  return { ok: true };
}

const stepUpAssert = assertImpersonationStepUpRequired({
  nodeEnv: process.env.NODE_ENV,
  requireAcr2: value.IMPERSONATION_REQUIRE_ACR_2,
});
if (!stepUpAssert.ok) {
  console.error(stepUpAssert.reason);
  process.exit(1);
}

// Stripe secret key + webhook secret — fail fast at boot in production
// instead of letting `getStripe()` crash on the first donation. (PR #193
// review, finding #6.) Local dev keeps both Optional so an env without
// Stripe still boots — the user-facing surface (Settings panel 502, donor
// flow blocked) tells the operator what's missing.
if (process.env.NODE_ENV === "production") {
  if (!value.STRIPE_SECRET_KEY) {
    console.error(
      "[api] STRIPE_SECRET_KEY is strictly required in production — without it every donation attempt 502s.",
    );
    process.exit(1);
  }
  // Format sanity-check so a typo'd value (e.g. swapped publishable key)
  // surfaces at boot rather than on the first PaymentIntent.create.
  if (!/^sk_(test|live)_/.test(value.STRIPE_SECRET_KEY)) {
    console.error(
      "[api] STRIPE_SECRET_KEY must start with `sk_test_` or `sk_live_` — looks like a publishable key or restricted key was set instead.",
    );
    process.exit(1);
  }
  if (!value.STRIPE_WEBHOOK_SECRET) {
    console.error(
      "[api] STRIPE_WEBHOOK_SECRET is strictly required in production — without it every webhook 400s on signature verification.",
    );
    process.exit(1);
  }
  if (!value.STRIPE_WEBHOOK_SECRET.startsWith("whsec_")) {
    console.error(
      "[api] STRIPE_WEBHOOK_SECRET must start with `whsec_` — got something else, likely the wrong dashboard field copied.",
    );
    process.exit(1);
  }
}

const adminUrl = value.KEYCLOAK_ADMIN_URL ?? value.KEYCLOAK_INTERNAL_URL ?? value.KEYCLOAK_URL;
const isLocalHost =
  /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|givernance-keycloak)(:|$|\/)/i.test(adminUrl);
if (process.env.NODE_ENV === "production" && !adminUrl.startsWith("https://") && !isLocalHost) {
  console.error(
    `[api] Keycloak admin URL must be HTTPS in production (got '${adminUrl}') — client-credentials over cleartext leaks the admin secret.`,
  );
  process.exit(1);
}

export const env: ApiEnv = value;
