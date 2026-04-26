/**
 * Enterprise-track tenant routes (issue #110 / ADR-016 / doc 22 §3.2, §5).
 *
 *  - `POST /v1/superadmin/tenants`                         — super-admin, create enterprise tenant.
 *  - `GET  /v1/superadmin/tenants`                         — super-admin, list + filter.
 *  - `GET  /v1/superadmin/tenants/:id/detail`              — super-admin, detail + tabs data.
 *  - `POST /v1/superadmin/tenants/:id/provision-idp`       — super-admin.
 *  - `PATCH /v1/superadmin/tenants/:id/idp`                — super-admin, rotate/patch config.
 *  - `DELETE /v1/superadmin/tenants/:id/idp`               — super-admin.
 *  - `POST /v1/superadmin/tenants/:id/lifecycle`           — super-admin, suspend/archive/activate.
 *  - `POST   /v1/superadmin/tenants/:id/first-admin-invitations`              — super-admin, seed first user.
 *  - `POST   /v1/superadmin/tenants/:id/first-admin-invitations/:iid/resend`  — super-admin, rotate token.
 *  - `DELETE /v1/superadmin/tenants/:id/first-admin-invitations/:iid`         — super-admin, revoke.
 *  - `POST /v1/tenants/:id/domains`                   — super_admin OR owning org_admin.
 *  - `POST /v1/tenants/:id/domains/:domain/verify`    — same auth.
 *  - `DELETE /v1/tenants/:id/domains/:domain`         — same auth.
 *
 * Auth model:
 *  - `requireSuperAdmin` guards admin-namespaced routes (backend pair of doc 22 §6.4).
 *  - Domain CRUD lives under `/v1/tenants/:id/...` and uses
 *    `requireSuperAdminOrOwnOrgAdmin` so an org_admin can manage their own
 *    tenant's domains without needing the super-admin role.
 */

import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireSuperAdmin, requireSuperAdminOrOwnOrgAdmin } from "../../lib/guards.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  ProblemDetailSchema,
  problemDetail,
  UuidSchema,
} from "../../lib/schemas.js";
import {
  claimDomain,
  createEnterpriseTenant,
  deleteIdp,
  getTenantDetail,
  inviteFirstEnterpriseUser,
  listRecentAudit,
  listTenantsForAdmin,
  provisionIdp,
  resendFirstEnterpriseInvitation,
  revokeDomain,
  revokeFirstEnterpriseInvitation,
  transitionTenantStatus,
  verifyDomain,
} from "./service.js";

// ─── Schemas ────────────────────────────────────────────────────────────────

const OrgIdParams = Type.Object({ id: UuidSchema });
const DomainScopedParams = Type.Object({
  orgId: UuidSchema,
  domain: Type.String({ minLength: 3, maxLength: 253 }),
});
const DomainRootParams = Type.Object({ orgId: UuidSchema });

const CreateEnterpriseBody = Type.Object({
  name: Type.String({ minLength: 2, maxLength: 255 }),
  slug: Type.String({ minLength: 2, maxLength: 50 }),
  plan: Type.Optional(
    Type.Union([Type.Literal("starter"), Type.Literal("pro"), Type.Literal("enterprise")]),
  ),
});

const CreateEnterpriseResponse = Type.Object({
  tenantId: UuidSchema,
  slug: Type.String(),
  keycloakOrgId: Type.String(),
  status: Type.String(),
});

const ClaimDomainBody = Type.Object({
  domain: Type.String({ minLength: 3, maxLength: 253 }),
});

const ClaimDomainResponse = Type.Object({
  domain: Type.String(),
  dnsTxtValue: Type.String(),
  state: Type.Literal("pending_dns"),
});

const VerifyDomainResponse = Type.Object({
  domain: Type.String(),
  state: Type.Literal("verified"),
});

const TenantSummarySchema = Type.Object({
  id: UuidSchema,
  name: Type.String(),
  slug: Type.String(),
  plan: Type.String(),
  status: Type.String(),
  createdVia: Type.String(),
  verifiedAt: Type.Union([Type.String(), Type.Null()]),
  primaryDomain: Type.Union([Type.String(), Type.Null()]),
  keycloakOrgId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

const TenantListQuery = Type.Object({
  status: Type.Optional(Type.String({ maxLength: 32 })),
  createdVia: Type.Optional(Type.String({ maxLength: 32 })),
  q: Type.Optional(Type.String({ maxLength: 255 })),
});

const TenantDetailResponse = Type.Object({
  tenant: TenantSummarySchema,
  domains: Type.Array(
    Type.Object({
      id: UuidSchema,
      domain: Type.String(),
      state: Type.String(),
      dnsTxtValue: Type.String(),
      verifiedAt: Type.Union([Type.String(), Type.Null()]),
      createdAt: Type.String(),
    }),
  ),
  users: Type.Array(
    Type.Object({
      id: UuidSchema,
      email: Type.String(),
      firstName: Type.String(),
      lastName: Type.String(),
      role: Type.String(),
      firstAdmin: Type.Boolean(),
      provisionalUntil: Type.Union([Type.String(), Type.Null()]),
      lastVisitedAt: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  recentAudit: Type.Array(
    Type.Object({
      id: UuidSchema,
      action: Type.String(),
      resourceType: Type.Union([Type.String(), Type.Null()]),
      resourceId: Type.Union([Type.String(), Type.Null()]),
      userId: Type.Union([Type.String(), Type.Null()]),
      newValues: Type.Any(),
      oldValues: Type.Any(),
      createdAt: Type.String(),
    }),
  ),
  firstAdminInvitation: Type.Union([
    Type.Object({
      id: UuidSchema,
      email: Type.String(),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("accepted"),
        Type.Literal("expired"),
      ]),
      expiresAt: Type.String(),
      acceptedAt: Type.Union([Type.String(), Type.Null()]),
      createdAt: Type.String(),
    }),
    Type.Null(),
  ]),
});

const OidcConfigSchema = Type.Object({
  type: Type.Literal("oidc"),
  discoveryUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2048 })),
  issuer: Type.Optional(Type.String({ format: "uri", maxLength: 2048 })),
  authorizationUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2048 })),
  tokenUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2048 })),
  userInfoUrl: Type.Optional(Type.String({ format: "uri", maxLength: 2048 })),
  clientId: Type.String({ minLength: 1, maxLength: 255 }),
  clientSecret: Type.String({ minLength: 1, maxLength: 4096 }),
  roleMappings: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const SamlConfigSchema = Type.Object({
  type: Type.Literal("saml"),
  entityId: Type.String({ minLength: 1, maxLength: 512 }),
  singleSignOnServiceUrl: Type.String({ format: "uri", maxLength: 2048 }),
  x509Certificate: Type.String({ minLength: 100, maxLength: 8192 }),
  nameIdPolicyFormat: Type.Optional(Type.String({ maxLength: 128 })),
});

const ProvisionIdpBody = Type.Union([OidcConfigSchema, SamlConfigSchema]);

const IdpResponse = Type.Object({
  alias: Type.String(),
});

const LifecycleBody = Type.Object({
  action: Type.Union([Type.Literal("suspend"), Type.Literal("archive"), Type.Literal("activate")]),
  reason: Type.Optional(Type.String({ maxLength: 500 })),
});

const LifecycleResponse = Type.Object({
  status: Type.String(),
});

const InviteFirstAdminBody = Type.Object({
  email: Type.String({ format: "email", maxLength: 255 }),
});

const InviteFirstAdminResponse = Type.Object({
  invitationId: UuidSchema,
  invitationToken: Type.String(),
  expiresAt: Type.String(),
});

const FirstAdminInvitationParams = Type.Object({
  id: UuidSchema,
  invitationId: UuidSchema,
});

// ─── Audit helpers ──────────────────────────────────────────────────────────

function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function auditFromRequest(request: FastifyRequest) {
  const ua = request.headers["user-agent"];
  return {
    actorUserId: request.auth?.userId ?? null,
    ipHash: hashIp(request.ip),
    userAgent: typeof ua === "string" ? ua.slice(0, 512) : undefined,
  };
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function tenantAdminRoutes(app: FastifyInstance) {
  /** POST /v1/superadmin/tenants — create an enterprise-track tenant (super-admin). */
  app.post(
    "/superadmin/tenants",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        body: CreateEnterpriseBody,
        response: {
          201: DataResponse(CreateEnterpriseResponse),
          409: ProblemDetailSchema,
          422: ProblemDetailSchema,
          502: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        slug: string;
        plan?: "starter" | "pro" | "enterprise";
      };
      try {
        const res = await createEnterpriseTenant({
          ...body,
          audit: auditFromRequest(request),
        });
        if (!res.ok) {
          const status = res.error === "invalid_slug" ? 422 : 409;
          return reply
            .status(status)
            .send(
              problemDetail(
                status,
                res.error === "invalid_slug" ? "Invalid slug" : "Slug taken",
                res.error === "invalid_slug"
                  ? "The tenant URL is invalid or reserved."
                  : "This tenant URL is already taken.",
              ),
            );
        }
        return reply.status(201).send({
          data: {
            tenantId: res.tenantId,
            slug: res.slug,
            keycloakOrgId: res.keycloakOrgId,
            status: "provisional",
          },
        });
      } catch (err) {
        request.log.error({ err }, "createEnterpriseTenant failed");
        return reply
          .status(502)
          .send(
            problemDetail(
              502,
              "Upstream error",
              "Could not provision the Keycloak Organization — please retry.",
            ),
          );
      }
    },
  );

  /** GET /v1/superadmin/tenants — list tenants with filters (super-admin). */
  app.get(
    "/superadmin/tenants",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        querystring: TenantListQuery,
        response: {
          200: DataArrayResponseNoPagination(TenantSummarySchema),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const query = request.query as { status?: string; createdVia?: string; q?: string };
      const rows = await listTenantsForAdmin(query);
      return reply.send({ data: rows });
    },
  );

  /** GET /v1/superadmin/tenants/:id/detail — tenant detail + tabs payload (super-admin). */
  app.get(
    "/superadmin/tenants/:id/detail",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        params: OrgIdParams,
        response: {
          200: DataResponse(TenantDetailResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const detail = await getTenantDetail(id);
      if (!detail) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Tenant not found."));
      }
      const recentAudit = await listRecentAudit(id, 50);
      return reply.send({ data: { ...detail, recentAudit } });
    },
  );

  /** POST /v1/superadmin/tenants/:id/provision-idp — create + bind OIDC/SAML IdP. */
  app.post(
    "/superadmin/tenants/:id/provision-idp",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        params: OrgIdParams,
        body: ProvisionIdpBody,
        response: {
          201: DataResponse(IdpResponse),
          409: ProblemDetailSchema,
          422: ProblemDetailSchema,
          502: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Parameters<typeof provisionIdp>[0]["config"];
      try {
        const res = await provisionIdp({
          orgId: id,
          config: body,
          audit: auditFromRequest(request),
        });
        if (!res.ok) {
          const status = provisionIdpStatus(res.error);
          const title = res.error === "alias_taken" ? "IdP already exists" : "Cannot provision IdP";
          return reply
            .status(status)
            .send(problemDetail(status, title, describeIdpError(res.error)));
        }
        return reply.status(201).send({ data: { alias: res.alias } });
      } catch (err) {
        request.log.error({ err }, "provisionIdp failed");
        return reply
          .status(502)
          .send(
            problemDetail(
              502,
              "Upstream error",
              "Could not configure the identity provider on Keycloak — please retry.",
            ),
          );
      }
    },
  );

  /** PATCH /v1/superadmin/tenants/:id/idp — rotate secret / adjust config. */
  app.patch(
    "/superadmin/tenants/:id/idp",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        params: OrgIdParams,
        body: ProvisionIdpBody,
        response: {
          200: DataResponse(IdpResponse),
          422: ProblemDetailSchema,
          502: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Parameters<typeof provisionIdp>[0]["config"];
      // Rotate = delete-then-create; alias stays stable across rotations so the
      // Keycloak Organization binding does not need to be replayed. The KC
      // delete is idempotent when the alias is missing.
      try {
        const del = await deleteIdp({ orgId: id, audit: auditFromRequest(request) });
        if (!del.ok && del.error === "tenant_not_found") {
          return reply.status(404).send(problemDetail(404, "Not Found", "Tenant not found."));
        }
        const res = await provisionIdp({
          orgId: id,
          config: body,
          audit: auditFromRequest(request),
        });
        if (!res.ok) {
          return reply
            .status(422)
            .send(problemDetail(422, "Cannot rotate IdP", describeIdpError(res.error)));
        }
        return reply.send({ data: { alias: res.alias } });
      } catch (err) {
        request.log.error({ err }, "PATCH idp failed");
        return reply
          .status(502)
          .send(problemDetail(502, "Upstream error", "Could not rotate the identity provider."));
      }
    },
  );

  /** DELETE /v1/superadmin/tenants/:id/idp — unbind + remove. */
  app.delete(
    "/superadmin/tenants/:id/idp",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        params: OrgIdParams,
        response: { 204: Type.Null(), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const res = await deleteIdp({ orgId: id, audit: auditFromRequest(request) });
      if (!res.ok) {
        const status = res.error === "tenant_not_found" ? 404 : 404;
        return reply
          .status(status)
          .send(problemDetail(status, "Not Found", describeIdpError(res.error)));
      }
      return reply.status(204).send();
    },
  );

  /** POST /v1/superadmin/tenants/:id/lifecycle — suspend/archive/activate. */
  app.post(
    "/superadmin/tenants/:id/lifecycle",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        params: OrgIdParams,
        body: LifecycleBody,
        response: {
          200: DataResponse(LifecycleResponse),
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { action: "suspend" | "archive" | "activate"; reason?: string };
      const res = await transitionTenantStatus({
        orgId: id,
        next: lifecycleTargetStatus(body.action),
        reason: body.reason,
        audit: auditFromRequest(request),
      });
      if (!res.ok) {
        const { status, title, detail } = lifecycleErrorResponse(res.error);
        return reply.status(status).send(problemDetail(status, title, detail));
      }
      return reply.send({ data: { status: res.status } });
    },
  );

  /**
   * POST /v1/superadmin/tenants/:id/first-admin-invitations — seed the first
   * enterprise user. Modelled as a collection-create to keep the URL
   * structure REST-clean (so the resend / cancel routes below can be true
   * sub-resource paths rather than action verbs with children — review
   * MEDIUM finding on PR #154).
   */
  app.post(
    "/superadmin/tenants/:id/first-admin-invitations",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        params: OrgIdParams,
        body: InviteFirstAdminBody,
        response: {
          201: DataResponse(InviteFirstAdminResponse),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { email: string };
      const res = await inviteFirstEnterpriseUser({
        orgId: id,
        email: body.email,
        audit: auditFromRequest(request),
      });
      if (!res.ok) {
        if (res.error === "already_accepted") {
          request.log.info(
            { event: "tenant.first_admin_invite_rejected", reason: res.error, tenantId: id },
            "rejected — already accepted",
          );
          return reply
            .status(409)
            .send(
              problemDetail(
                409,
                "Conflict",
                "A first admin has already been provisioned for this tenant.",
              ),
            );
        }
        request.log.info(
          { event: "tenant.first_admin_invite_rejected", reason: res.error, tenantId: id },
          "rejected — tenant not found",
        );
        return reply.status(404).send(problemDetail(404, "Not Found", "Tenant not found."));
      }
      request.log.info(
        { event: "tenant.first_admin_invited", tenantId: id, invitationId: res.invitationId },
        "first-admin invitation created",
      );
      return reply.status(201).send({
        data: {
          invitationId: res.invitationId,
          invitationToken: res.token,
          expiresAt: res.expiresAt.toISOString(),
        },
      });
    },
  );

  /**
   * POST /v1/superadmin/tenants/:id/first-admin-invitations/:invitationId/resend
   *
   * Rotate the token + expiry on a pending first-admin invitation. Returns
   * the fresh token (200 + body, deviating from the team-invite 204) so
   * the operator can copy a fallback link until the email worker (#145)
   * ships. Status code is 200 — no resource is created (the row stays;
   * only the token + expiry mutate) and we deliberately need a body.
   */
  app.post(
    "/superadmin/tenants/:id/first-admin-invitations/:invitationId/resend",
    {
      preHandler: requireSuperAdmin,
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        tags: ["Tenant Admin"],
        params: FirstAdminInvitationParams,
        response: {
          200: DataResponse(InviteFirstAdminResponse),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id, invitationId } = request.params as { id: string; invitationId: string };
      const res = await resendFirstEnterpriseInvitation({
        orgId: id,
        invitationId,
        audit: auditFromRequest(request),
      });
      if (!res.ok) {
        request.log.info(
          {
            event: "tenant.first_admin_invite_resend_rejected",
            reason: res.error,
            tenantId: id,
            invitationId,
          },
          "resend rejected",
        );
        if (res.error === "already_accepted") {
          return reply
            .status(409)
            .send(problemDetail(409, "Conflict", "This invitation has already been accepted."));
        }
        return reply.status(404).send(problemDetail(404, "Not Found", "Invitation not found."));
      }
      request.log.info(
        {
          event: "tenant.first_admin_invite_resent",
          tenantId: id,
          invitationId: res.invitationId,
        },
        "first-admin invitation resent",
      );
      return reply.status(200).send({
        data: {
          invitationId: res.invitationId,
          invitationToken: res.token,
          expiresAt: res.expiresAt.toISOString(),
        },
      });
    },
  );

  /** DELETE /v1/superadmin/tenants/:id/first-admin-invitations/:invitationId — revoke. */
  app.delete(
    "/superadmin/tenants/:id/first-admin-invitations/:invitationId",
    {
      preHandler: requireSuperAdmin,
      schema: {
        tags: ["Tenant Admin"],
        params: FirstAdminInvitationParams,
        response: {
          204: Type.Null(),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { id, invitationId } = request.params as { id: string; invitationId: string };
      const res = await revokeFirstEnterpriseInvitation({
        orgId: id,
        invitationId,
        audit: auditFromRequest(request),
      });
      if (!res.ok) {
        request.log.info(
          {
            event: "tenant.first_admin_invite_revoke_rejected",
            reason: res.error,
            tenantId: id,
            invitationId,
          },
          "revoke rejected",
        );
        if (res.error === "already_accepted") {
          return reply
            .status(409)
            .send(
              problemDetail(
                409,
                "Conflict",
                "This invitation has already been accepted and cannot be revoked.",
              ),
            );
        }
        return reply.status(404).send(problemDetail(404, "Not Found", "Invitation not found."));
      }
      request.log.info(
        { event: "tenant.first_admin_invite_revoked", tenantId: id, invitationId },
        "first-admin invitation revoked",
      );
      return reply.status(204).send();
    },
  );

  // ─── Domain CRUD (super-admin OR owning org_admin) ────────────────────────
  //
  // Paths use `:orgId` (not `:id`) because `requireSuperAdminOrOwnOrgAdmin`
  // reads `params.orgId` when checking same-tenant authorisation for an
  // org_admin. Renaming the slot back to `:id` would silently allow any
  // authenticated org_admin to act on any tenant.

  /** POST /v1/tenants/:orgId/domains — claim a domain on the tenant. */
  app.post(
    "/tenants/:orgId/domains",
    {
      preHandler: requireSuperAdminOrOwnOrgAdmin,
      schema: {
        tags: ["Tenant Domains"],
        params: DomainRootParams,
        body: ClaimDomainBody,
        response: {
          201: DataResponse(ClaimDomainResponse),
          409: ProblemDetailSchema,
          422: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params as { orgId: string };
      const res = await claimDomain({
        orgId,
        domain: (request.body as { domain: string }).domain,
        audit: auditFromRequest(request),
      });
      if (!res.ok) {
        const status =
          res.error === "tenant_not_found" ? 404 : res.error === "already_claimed" ? 409 : 422;
        return reply
          .status(status)
          .send(
            problemDetail(
              status,
              describeDomainErrorTitle(res.error),
              describeDomainErrorDetail(res.error),
            ),
          );
      }
      return reply.status(201).send({
        data: { domain: res.domain, dnsTxtValue: res.dnsTxtValue, state: res.state },
      });
    },
  );

  /** POST /v1/tenants/:orgId/domains/:domain/verify — trigger DNS TXT lookup. */
  app.post(
    "/tenants/:orgId/domains/:domain/verify",
    {
      preHandler: requireSuperAdminOrOwnOrgAdmin,
      schema: {
        tags: ["Tenant Domains"],
        params: DomainScopedParams,
        response: {
          200: DataResponse(VerifyDomainResponse),
          409: ProblemDetailSchema,
          422: ProblemDetailSchema,
          502: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const { orgId, domain } = request.params as { orgId: string; domain: string };
      try {
        const res = await verifyDomain({
          orgId,
          domain,
          audit: auditFromRequest(request),
        });
        if (!res.ok) {
          const status = verifyDomainStatus(res.error);
          return reply
            .status(status)
            .send(
              problemDetail(
                status,
                describeVerifyErrorTitle(res.error),
                describeVerifyErrorDetail(res.error),
              ),
            );
        }
        return reply.send({ data: { domain: res.domain, state: res.state } });
      } catch (err) {
        request.log.error({ err }, "verifyDomain failed");
        return reply
          .status(502)
          .send(
            problemDetail(502, "Upstream error", "Could not verify the domain — please retry."),
          );
      }
    },
  );

  /** DELETE /v1/tenants/:orgId/domains/:domain — revoke (soft delete). */
  app.delete(
    "/tenants/:orgId/domains/:domain",
    {
      preHandler: requireSuperAdminOrOwnOrgAdmin,
      schema: {
        tags: ["Tenant Domains"],
        params: DomainScopedParams,
        response: { 204: Type.Null(), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { orgId, domain } = request.params as { orgId: string; domain: string };
      const res = await revokeDomain({
        orgId,
        domain,
        audit: auditFromRequest(request),
      });
      if (!res.ok) {
        return reply.status(404).send(problemDetail(404, "Not Found", "Domain claim not found."));
      }
      return reply.status(204).send();
    },
  );
}

// ─── Error-to-status helpers ────────────────────────────────────────────────

function provisionIdpStatus(error: string): number {
  if (error === "tenant_not_found") return 404;
  if (error === "alias_taken") return 409;
  return 422;
}

function lifecycleTargetStatus(
  action: "suspend" | "archive" | "activate",
): "suspended" | "archived" | "active" {
  if (action === "suspend") return "suspended";
  if (action === "archive") return "archived";
  return "active";
}

function lifecycleErrorResponse(error: string): {
  status: number;
  title: string;
  detail: string;
} {
  if (error === "tenant_not_found") {
    return { status: 404, title: "Not Found", detail: "Tenant not found." };
  }
  return {
    status: 422,
    title: "Invalid transition",
    detail: "This status transition is not allowed in the tenant's current state.",
  };
}

function verifyDomainStatus(error: string): number {
  if (error === "not_found" || error === "tenant_not_found") return 404;
  if (error === "already_verified") return 409;
  if (error === "dns_timeout") return 502;
  return 422;
}

// ─── Error-copy helpers ─────────────────────────────────────────────────────

function describeIdpError(error: string): string {
  switch (error) {
    case "tenant_not_found":
      return "Tenant not found.";
    case "tenant_has_no_org":
      return "Tenant is missing its Keycloak Organization — recreate the tenant.";
    case "alias_taken":
      return "An identity provider with this alias already exists.";
    case "invalid_config":
      return "Identity-provider configuration is missing required fields.";
    case "not_bound":
      return "No identity provider is currently bound to this tenant.";
    default:
      return "Identity-provider operation failed.";
  }
}

function describeDomainErrorTitle(error: string): string {
  if (error === "already_claimed") return "Domain already claimed";
  if (error === "personal_email") return "Personal-email domain";
  if (error === "tenant_not_found") return "Tenant not found";
  return "Invalid domain";
}

function describeDomainErrorDetail(error: string): string {
  switch (error) {
    case "already_claimed":
      return "This domain is already verified on another tenant or is pending verification. Contact support if you believe this is an error.";
    case "personal_email":
      return "Personal-email domains (gmail.com, outlook.com, …) cannot be claimed as tenant domains.";
    case "tenant_not_found":
      return "Tenant not found.";
    case "invalid_domain":
      return "Domain is syntactically invalid. Use the canonical host form (example.org).";
    default:
      return "Could not claim the domain.";
  }
}

function describeVerifyErrorTitle(error: string): string {
  if (error === "not_found" || error === "tenant_not_found") return "Not Found";
  if (error === "already_verified") return "Already verified";
  if (error === "dns_timeout") return "DNS timeout";
  return "DNS verification failed";
}

function describeVerifyErrorDetail(error: string): string {
  switch (error) {
    case "not_found":
      return "No domain claim found for this tenant.";
    case "tenant_not_found":
      return "Tenant not found.";
    case "already_verified":
      return "This domain is already verified.";
    case "dns_timeout":
      return "DNS resolver timed out. Verify the TXT record is published and try again in a few minutes.";
    case "dns_mismatch":
      return "The DNS TXT record was not found or did not match the expected value.";
    default:
      return "Could not verify the domain.";
  }
}
