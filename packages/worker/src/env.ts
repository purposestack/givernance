/** Strict environment validation for the worker process — crash early on missing vars */

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

const EmailProvider = Type.Union(
  [
    /** Mailpit / nodemailer SMTP — local dev default, also the staging fallback if Resend is unavailable. */
    Type.Literal("mailpit"),
    /** Resend HTTP API — staging / prod transactional path (issue #190, ADR docs/05 §3.1). */
    Type.Literal("resend"),
  ],
  { default: "mailpit" },
);

const EnvSchema = Type.Object({
  /** PostgreSQL connection string (owner role, bypasses RLS) */
  DATABASE_URL: Type.String({ minLength: 1 }),
  /** PostgreSQL connection string (app role, subject to RLS) */
  DATABASE_URL_APP: Type.String({ minLength: 1 }),
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
  /** S3 bucket for campaign documents */
  S3_CAMPAIGNS_BUCKET: Type.String({ minLength: 1, default: "campaigns" }),
  /**
   * S3 bucket for org branding assets (Epic #286). Public-read at the
   * bucket level — see api/src/env.ts comment for full rationale.
   */
  S3_BRANDING_BUCKET: Type.String({ minLength: 1, default: "branding" }),
  /**
   * S3 bucket for bulk-import uploads (Epic #373). Private — every
   * object carries PII (donor names, emails, addresses). The processor
   * reads files from here under the worker's RLS context and never
   * exposes them off-server. ADR-023.
   */
  S3_BULK_IMPORT_BUCKET: Type.String({ minLength: 1, default: "bulk-imports" }),
  /**
   * S3 bucket for super-admin monthly finance reports (issue #443).
   * **Private** — the PDF aggregates cross-tenant donation volume,
   * platform revenue, Stripe fees and tenant-level Mobilisation Score.
   * Served back through the API only (streaming-through-API per issue
   * #214); never via presigned URL nor public-read. Key shape:
   * `monthly/{YYYY-MM}/{report_id}.pdf`. ADR-023.
   */
  S3_REPORTS_BUCKET: Type.String({ minLength: 1, default: "reports" }),
  /**
   * Private bucket for ISO 20022 camt.053 bank statements (Epic #318,
   * ADR-023 + ADR-028). 10-year Swiss CO Art. 958f retention; signed
   * URLs only; SSE-S3 at rest. Worker reads accepted uploads here and
   * may relocate rejected files to the `{org_id}/camt053/rejected/`
   * prefix on XSD-fail / foreign-IBAN.
   */
  S3_BANK_STATEMENTS_BUCKET: Type.String({ minLength: 1, default: "bank-statements" }),
  /** S3 region */
  S3_REGION: Type.String({ minLength: 1, default: "us-east-1" }),
  /**
   * Base URL the Keycloak sync worker uses when emitting
   * `logo_url` into the KC organization attributes. Defaults to
   * `${S3_ENDPOINT}/${S3_BRANDING_BUCKET}` for local dev. Production
   * overrides with the public CDN (HTTPS-only — the KC login
   * template's M1 guard rejects non-HTTPS URLs).
   */
  KEYCLOAK_LOGO_PUBLIC_URL_BASE: Type.Optional(Type.String({ minLength: 1 })),
  /** Keycloak Admin API base URL — used by the KC sync worker job. */
  KEYCLOAK_URL: Type.Optional(Type.String({ minLength: 1 })),
  KEYCLOAK_INTERNAL_URL: Type.Optional(Type.String({ minLength: 1 })),
  KEYCLOAK_ADMIN_URL: Type.Optional(Type.String({ minLength: 1 })),
  KEYCLOAK_REALM: Type.String({ minLength: 1, default: "givernance" }),
  KEYCLOAK_ADMIN_CLIENT_ID: Type.String({ minLength: 1, default: "givernance-admin" }),
  KEYCLOAK_ADMIN_CLIENT_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  /** Log level */
  LOG_LEVEL: LogLevel,
  /** Stripe secret key (sk_test_... or sk_live_...) */
  STRIPE_SECRET_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** ExchangeRate-API key used for currency conversion refreshes */
  EXCHANGE_RATE_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** Outbound email backend — `mailpit` (SMTP / dev) or `resend` (HTTP API / staging+prod) */
  EMAIL_PROVIDER: EmailProvider,
  /**
   * RFC 5322 From header for outbound mail. Used by both backends; falls
   * back to `SMTP_FROM` (the legacy name) for dev `.env` files that haven't
   * migrated yet — see `resolveEmailFrom()` below.
   */
  EMAIL_FROM: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Resend API key. Required when `EMAIL_PROVIDER=resend`; the runtime check
   * lives in `lib/email.ts` so the provider switch can crash with a helpful
   * message at boot rather than at first send.
   */
  RESEND_API_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** SMTP host for outbound mail — defaults to local Mailpit */
  SMTP_HOST: Type.String({ minLength: 1, default: "localhost" }),
  /** SMTP port (1025 for Mailpit, 587 for submission, 465 for SMTPS) */
  SMTP_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 1025 }),
  /** SMTP username — leave unset (empty) for auth-less dev relays like Mailpit */
  SMTP_USER: Type.Optional(Type.String()),
  /** SMTP password — leave unset (empty) for auth-less dev relays like Mailpit */
  SMTP_PASS: Type.Optional(Type.String()),
  /** Legacy alias for EMAIL_FROM — kept so dev `.env` files don't break in this PR's release window. */
  SMTP_FROM: Type.Optional(Type.String({ minLength: 1 })),
  /** Public URL of the web app — used to build verification links sent by email */
  APP_URL: Type.String({ minLength: 1, default: "http://localhost:3000" }),
});

export type WorkerEnv = Static<typeof EnvSchema>;

const value = Value.Default(EnvSchema, Value.Convert(EnvSchema, { ...process.env }));

if (!Value.Check(EnvSchema, value)) {
  const errors = [...Value.Errors(EnvSchema, value)];
  const formatted = errors.map((e) => `  ${e.path.slice(1)}: ${e.message}`).join("\n");
  console.error(`[worker] Missing or invalid environment variables:\n${formatted}`);
  process.exit(1);
}

export const env: WorkerEnv = value;

/**
 * RFC 5322 From header for outbound mail. Prefers the new `EMAIL_FROM` name
 * (used by both backends) and falls back to the legacy `SMTP_FROM` so a dev
 * upgrading their `.env` doesn't get a broken send during the migration
 * window. Default mirrors the local Mailpit hostname.
 */
export function resolveEmailFrom(): string {
  return env.EMAIL_FROM ?? env.SMTP_FROM ?? "Givernance <no-reply@givernance.local>";
}
