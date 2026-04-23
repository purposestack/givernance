/**
 * Public self-serve signup routes (issue #108 / ADR-016).
 *
 * All endpoints are unauthenticated and rate-limited. CAPTCHA is fail-open
 * in NODE_ENV=test (see `lib/captcha.ts`), fail-closed elsewhere.
 */

import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { defaultCaptchaVerifier } from "../../lib/captcha.js";
import {
  DataResponse,
  ErrorResponses,
  problemDetail,
  ProblemDetailSchema,
  UuidSchema,
} from "../../lib/schemas.js";
import { lookupTenantForEmail, resendVerification, signup, verifySignup } from "./service.js";

// ─── Request / response shapes ──────────────────────────────────────────────

const SignupBody = Type.Object({
  orgName: Type.String({ minLength: 2, maxLength: 255 }),
  slug: Type.String({ minLength: 2, maxLength: 50 }),
  firstName: Type.String({ minLength: 1, maxLength: 255 }),
  lastName: Type.String({ minLength: 1, maxLength: 255 }),
  email: Type.String({ format: "email", maxLength: 255 }),
  country: Type.Optional(Type.String({ maxLength: 2 })),
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
});

const SignupResponse = Type.Object({
  tenantId: UuidSchema,
  email: Type.String(),
  checkEmail: Type.Literal(true),
});

const VerifyResponse = Type.Object({
  tenantId: UuidSchema,
  userId: UuidSchema,
  slug: Type.String(),
  provisionalUntil: Type.String({ format: "date-time" }),
});

const LookupQuery = Type.Object({
  email: Type.String({ format: "email", maxLength: 255 }),
});

const LookupResponse = Type.Object({
  hasExistingTenant: Type.Boolean(),
  hint: Type.Union([Type.Literal("contact_admin"), Type.Literal("create_new")]),
  orgSlug: Type.Optional(Type.String()),
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
      };
      const headers = request.headers as { "x-captcha-token"?: string };

      const captcha = await defaultCaptchaVerifier.verify(
        headers["x-captcha-token"],
        clientIp(request),
      );
      if (!captcha.ok) {
        return reply
          .status(422)
          .send(problemDetail(422, "CAPTCHA Required", "A valid CAPTCHA token is required."));
      }

      const ipHash = hashIp(clientIp(request));
      const userAgent =
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 512)
          : undefined;

      const result = await signup({
        ...body,
        ipHash,
        userAgent,
      });

      if (!result.ok) {
        const reasonMap: Record<string, { title: string; detail: string }> = {
          disposable_email: {
            title: "Email not accepted",
            detail: "The email address provided is not accepted for signup.",
          },
          invalid_slug: {
            title: "Invalid organization URL",
            detail: "The organization URL is invalid, reserved, or uses a non-ASCII prefix.",
          },
          slug_taken: {
            title: "Organization URL already taken",
            detail:
              "Another organization is already using this URL. Please choose a different one.",
          },
          email_in_use: {
            title: "Organization already exists",
            detail:
              "An organization with this email domain is already on Givernance — ask an admin to invite you.",
          },
        };
        const mapped = reasonMap[result.error.kind];
        return reply
          .status(422)
          .send(
            problemDetail(
              422,
              mapped?.title ?? "Signup rejected",
              mapped?.detail ?? "Signup rejected",
            ),
          );
      }

      return reply.status(201).send({
        data: {
          tenantId: result.tenantId,
          email: result.email,
          checkEmail: true as const,
        },
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
      // Never leak whether the email matched anything — always 204.
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
          410: ProblemDetailSchema,
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { token: string; firstName: string; lastName: string };
      const ipHash = hashIp(clientIp(request));
      const userAgent =
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"].slice(0, 512)
          : undefined;

      const result = await verifySignup({ ...body, ipHash, userAgent });

      if (!result.ok) {
        if (result.error.kind === "invalid_or_expired") {
          return reply
            .status(410)
            .send(
              problemDetail(
                410,
                "Verification expired",
                "The verification link has expired or is invalid.",
              ),
            );
        }
        return reply
          .status(422)
          .send(problemDetail(422, "Already verified", "This tenant has already been verified."));
      }

      return reply.status(201).send({
        data: {
          tenantId: result.tenantId,
          userId: result.userId,
          slug: result.slug,
          provisionalUntil: result.provisionalUntil,
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
