/**
 * Validators for the support-session API (issue #24).
 *
 * Two coexisting modes — "delegation" (own-name + extended rights) and
 * "impersonation" (pretend-to-be-user, scoped). The schemas live in their
 * own file so the doc explaining the model stays close to the shapes.
 */

import { type Static, Type } from "@sinclair/typebox";
import { IMPERSONATION_MODE_VALUES } from "../constants/impersonation";

/** A meaningful "test" / "asdf" gets rejected — 20 char floor matches doc-19. */
export const IMPERSONATION_REASON_MIN_LENGTH = 20;
export const IMPERSONATION_REASON_MAX_LENGTH = 2000;

const ImpersonationModeSchema = Type.Union(IMPERSONATION_MODE_VALUES.map((m) => Type.Literal(m)));

const UuidSchema = Type.String({
  format: "uuid",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});

/** Body for POST /admin/impersonation — start a new support session. */
export const ImpersonationStartBodySchema = Type.Object({
  targetUserId: UuidSchema,
  mode: ImpersonationModeSchema,
  reason: Type.String({
    minLength: IMPERSONATION_REASON_MIN_LENGTH,
    maxLength: IMPERSONATION_REASON_MAX_LENGTH,
    description:
      "Mandatory free-text reason — minimum 20 characters, included verbatim in audit_logs and surfaced in the banner.",
  }),
});
export type ImpersonationStartBody = Static<typeof ImpersonationStartBodySchema>;

/**
 * Response from POST /admin/impersonation. We return the JWT body so the
 * web tier can set the cookie via its own `Set-Cookie` (the cookie domain
 * lives on the web origin, not the API). Production deployments where API
 * and web share a domain can also rely on the `Set-Cookie` header the API
 * already emits — both paths work.
 */
export const ImpersonationStartResponseSchema = Type.Object({
  sessionId: UuidSchema,
  mode: ImpersonationModeSchema,
  expiresAt: Type.String({ format: "date-time" }),
  token: Type.String({
    description: "App-layer impersonation JWT (signed HS256, httpOnly cookie).",
  }),
  targetOrgId: UuidSchema,
  targetUserId: UuidSchema,
});

export const ImpersonationSessionSchema = Type.Object({
  id: UuidSchema,
  impersonatorKeycloakId: Type.String(),
  targetKeycloakId: Type.String(),
  targetOrgId: UuidSchema,
  targetRole: Type.String(),
  mode: ImpersonationModeSchema,
  reason: Type.String(),
  expiresAt: Type.String({ format: "date-time" }),
  endedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  endReason: Type.Union([Type.String(), Type.Null()]),
  ipHash: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  /** Derived field — true when `endedAt IS NULL AND expiresAt > now()`. */
  isActive: Type.Boolean(),
  // ── Enrichment fields (LEFT-JOIN'd from `users` + `tenants`) ──────────
  // Nullable when the joined row is missing — most realistic case is an
  // off-boarded operator whose `users` row was hard-deleted. The UI falls
  // back to the keycloak_id when null.
  targetFirstName: Type.Union([Type.String(), Type.Null()]),
  targetLastName: Type.Union([Type.String(), Type.Null()]),
  targetEmail: Type.Union([Type.String(), Type.Null()]),
  // App-side `users.id` of the target — null when the target's `users`
  // row is gone (off-boarded). The Replicate row-action (issue #428)
  // POSTs this back to `/v1/admin/impersonation` (which keys off the
  // app `users.id`, not the Keycloak `sub`); null = no Replicate button.
  targetUserId: Type.Union([UuidSchema, Type.Null()]),
  tenantName: Type.Union([Type.String(), Type.Null()]),
  tenantSlug: Type.Union([Type.String(), Type.Null()]),
  impersonatorFirstName: Type.Union([Type.String(), Type.Null()]),
  impersonatorLastName: Type.Union([Type.String(), Type.Null()]),
  impersonatorEmail: Type.Union([Type.String(), Type.Null()]),
});
export type ImpersonationSessionDTO = Static<typeof ImpersonationSessionSchema>;
