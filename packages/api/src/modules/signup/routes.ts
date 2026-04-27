/**
 * Public self-serve signup routes (issue #108 / ADR-016).
 *
 * All endpoints are unauthenticated and rate-limited. CAPTCHA is fail-open
 * when `CAPTCHA_MODE=disabled` or `NODE_ENV !== "production"`, fail-closed
 * otherwise.
 *
 * Review pass (PR #117):
 *  - SEC-5 / ENG-4: slug_taken + email_in_use → 409 with a single generic
 *    "Signup could not be completed" message (no enumeration oracle).
 *  - SEC-6: verify collapses all failure paths to 410 generic.
 *  - SEC-10: resend is rate-limited per-email via a Redis bucket in
 *    addition to the per-IP Fastify rate limit.
 *  - ENG-5: dropped the `checkEmail: Literal(true)` field from the 201
 *    response — 201 already means "verification required".
 *  - ENG-6: captcha failure → 400 generic, reason is logged internally.
 */

import { createHash } from "node:crypto";
import { SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { defaultCaptchaVerifier } from "../../lib/captcha.js";
import { redis } from "../../lib/redis.js";
import {
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  lookupTenantForEmail,
  openDomainDispute,
  resendVerification,
  signup,
  verifySignup,
} from "./service.js";

// ─── Request / response shapes ──────────────────────────────────────────────

const SignupBody = Type.Object({
  orgName: Type.String({ minLength: 2, maxLength: 255 }),
  slug: Type.String({ minLength: 2, maxLength: 50 }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.String({ format: "email", maxLength: 255 }),
  // ISO-3166-1 alpha-2. The `pattern` here mirrors the
  // `tenants_country_alpha2_chk` CHECK constraint (post-uppercase) so a bad
  // shape returns a generic 400 from the schema validator instead of
  // bubbling a 23514 to a 500 — preserves the SEC-5 "no enumeration oracle"
  // posture, since malformed inputs always 400 with the same error shape.
  // (Issue #153 / PR #158 security review.)
  country: Type.Optional(Type.String({ pattern: "^[A-Za-z]{2}$" })),
  // Issue #153: optional BCP-47 locale picked at signup. The service falls
  // back to country-derived default when omitted, so the form can ship the
  // picker as a follow-up without breaking the API contract.
  locale: Type.Optional(Type.Union(SUPPORTED_LOCALES.map((value) => Type.Literal(value)))),
});

const CaptchaHeader = Type.Object({
  "x-captcha-token": Type.Optional(Type.String({ maxLength: 4096 })),
});

const ResendBody = Type.Object({
  email: Type.String({ format: "email", maxLength: 255 }),
});

const VerifyBody = Type.Object({
  token: Type.String({ format: "uuid" }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  /**
   * The password the user picks on the verify form — provisioned as their
   * non-temporary Keycloak credential so they can log in immediately after
   * the post-verify redirect (issue #109 follow-up). Min 12 to comply with
   * the realm's brute-force protection without leaking exact policy back to
   * the frontend.
   */
  password: Type.String({ minLength: 12, maxLength: 128 }),
});

const SignupResponse = Type.Object({
  tenantId: UuidSchema,
  email: Type.String(),
});

const DisputeBody = Type.Object({
  email: Type.String({ format: "email", maxLength: 255 }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
});

const DisputeResponse = Type.Object({
  disputeId: UuidSchema,
});

// Web only consumes `slug` from this response (drives the post-verify
// Keycloak login redirect). Trim the public payload to match — `userId`
// in particular leaks a fresh KC user id into the browser for no
// consumer benefit. The internal `verifySignup` return type still
// carries the wider shape for service-internal use (audit, metrics).
const VerifyResponse = Type.Object({
  slug: Type.String(),
});

const LookupQuery = Type.Object({
  email: Type.String({ format: "email", maxLength: 255 }),
});

const LookupResponse = Type.Object({
  hasExistingTenant: Type.Boolean(),
  hint: Type.Union([Type.Literal("contact_admin"), Type.Literal("create_new")]),
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** SHA-256 hash of the client IP so we don't log raw addresses (docs/17). */
function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function clientIp(request: FastifyRequest): string | undefined {
  return request.ip ?? undefined;
}

/**
 * Per-email rate limit for the resend endpoint, on top of the per-IP Fastify
 * limit. Defends against a botnet spamming a single victim's inbox (SEC-10).
 * Returns `true` when the request is allowed, `false` when the bucket is full.
 */
async function acceptResendForEmail(email: string): Promise<boolean> {
  const key = `signup:resend:email:${email.trim().toLowerCase()}`;
  const hits = await redis.incr(key);
  if (hits === 1) {
    await redis.expire(key, 60 * 60); // 1h window
  }
  return hits <= 3; // max 3 resends per email per hour globally
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function signupRoutes(app: FastifyInstance) {
  /** POST /v1/public/signup — create a provisional self-serve tenant. */
  app.post(
    "/public/signup",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: {
        tags: ["Public Signup"],
        body: SignupBody,
        headers: CaptchaHeader,
        response: {
          201: DataResponse(SignupResponse),
          400: ProblemDetailSchema,
          409: ProblemDetailSchema,
          422: ProblemDetailSchema,
          429: Type.Any(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        orgName: string;
        slug: string;
        firstName: string;
        lastName: string;
        email: string;
        country?: string;
        locale?: "en" | "fr";
      };
      const headers = request.headers as { "x-captcha-token"?: string };

      const captcha = await defaultCaptchaVerifier.verify(
        headers["x-captcha-token"],
        clientIp(request),
      );
      if (!captcha.ok) {
        request.log.warn({ reason: captcha.reason }, "signup.captcha_rejected");
        // Generic message — don't tell the attacker which gate failed.
        return reply
          .status(400)
          .send(problemDetail(400, "Signup rejected", "Signup could not be completed."));
      }

      const ipHash = hashIp(clientIp(request));
      const userAgent =
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 512)
          : undefined;

      const result = await signup({ ...body, ipHash, userAgent });

      if (!result.ok) {
        request.log.info({ reason: result.error.kind }, "signup.rejected");
        if (result.error.kind === "invalid_slug") {
          return reply
            .status(422)
            .send(
              problemDetail(
                422,
                "Invalid organization URL",
                "The organization URL is invalid, reserved, or uses a non-ASCII prefix.",
              ),
            );
        }
        // Both slug_taken and email_in_use → 409 + generic message (SEC-5).
        return reply
          .status(409)
          .send(
            problemDetail(
              409,
              "Signup could not be completed",
              "Signup could not be completed. If you believe this is an error, please contact support.",
            ),
          );
      }

      return reply.status(201).send({
        data: {
          tenantId: result.tenantId,
          email: result.email,
        },
      });
    },
  );

  /** POST /v1/public/signup/dispute — file a dispute for a claimed domain. */
  app.post(
    "/public/signup/dispute",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 hour" } },
      schema: {
        tags: ["Public Signup"],
        body: DisputeBody,
        headers: CaptchaHeader,
        response: {
          201: DataResponse(DisputeResponse),
          400: ProblemDetailSchema,
          409: ProblemDetailSchema,
          429: Type.Any(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        firstName: string;
        lastName: string;
        reason?: string;
      };
      const headers = request.headers as { "x-captcha-token"?: string };

      const captcha = await defaultCaptchaVerifier.verify(
        headers["x-captcha-token"],
        clientIp(request),
      );
      if (!captcha.ok) {
        request.log.warn({ reason: captcha.reason }, "signup_dispute.captcha_rejected");
        return reply
          .status(400)
          .send(problemDetail(400, "Dispute rejected", "Dispute could not be submitted."));
      }

      const ipHash = hashIp(clientIp(request));
      const userAgent =
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 512)
          : undefined;

      const result = await openDomainDispute({ ...body, ipHash, userAgent });

      if (!result.ok) {
        if (result.error === "no_conflict" || result.error === "invalid_email") {
          return reply
            .status(404)
            .send(
              problemDetail(
                404,
                "No conflict",
                "This domain is not currently claimed or the email is invalid.",
              ),
            );
        }
        if (result.error === "already_disputed") {
          return reply
            .status(409)
            .send(
              problemDetail(
                409,
                "Already disputed",
                "A dispute has already been filed for this email.",
              ),
            );
        }
        return reply.status(400).send(problemDetail(400, "Error", "Could not open dispute"));
      }

      return reply.status(201).send({
        data: { disputeId: result.disputeId },
      });
    },
  );

  /** POST /v1/public/signup/resend — re-emit the verification email. */
  app.post(
    "/public/signup/resend",
    {
      config: { rateLimit: { max: 3, timeWindow: "1 hour" } },
      schema: {
        tags: ["Public Signup"],
        body: ResendBody,
        response: {
          204: Type.Null(),
          429: Type.Any(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      const allowed = await acceptResendForEmail(email);
      if (!allowed) {
        // Silently accept — the endpoint cannot be used as an enumeration or
        // spam-amplification oracle.
        return reply.status(204).send();
      }
      await resendVerification(email);
      return reply.status(204).send();
    },
  );

  /** POST /v1/public/signup/verify — complete the signup flow. */
  app.post(
    "/public/signup/verify",
    {
      config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
      schema: {
        tags: ["Public Signup"],
        body: VerifyBody,
        response: {
          201: DataResponse(VerifyResponse),
          // Fastify schema-validation rejection (e.g. password < 12) flows
          // through the global error handler at runtime — declare it here
          // so OpenAPI consumers can codegen the 400 branch.
          400: ProblemDetailSchema,
          410: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        token: string;
        firstName: string;
        lastName: string;
        password: string;
      };
      const ipHash = hashIp(clientIp(request));
      const userAgent =
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 512)
          : undefined;

      const result = await verifySignup({ ...body, ipHash, userAgent });

      if (!result.ok) {
        // SEC-6: collapse all failure modes into one generic 410 to remove
        // the status-code enumeration oracle. Service-side `log.warn`
        // already emits a structured `event` discriminator
        // (`signup.kc_user_exists`, `signup.first_admin_conflict`, etc.)
        // for SRE — this route-level log just gives a uniform breadcrumb
        // tying the request to whatever the service decided.
        request.log.info({ event: "signup.verify_rejected" }, "verify rejected");
        return reply
          .status(410)
          .send(
            problemDetail(
              410,
              "Verification expired",
              "This verification link is invalid or has already been used. Please start signup again.",
            ),
          );
      }

      return reply.status(201).send({
        data: {
          slug: result.slug,
        },
      });
    },
  );

  /** GET /v1/public/tenants/lookup?email=... — tenant discovery hint for the login flow. */
  app.get(
    "/public/tenants/lookup",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: {
        tags: ["Public Signup"],
        querystring: LookupQuery,
        response: {
          200: DataResponse(LookupResponse),
          429: Type.Any(),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { email } = request.query as { email: string };
      const result = await lookupTenantForEmail(email);
      return reply.status(200).send({ data: result });
    },
  );
}
