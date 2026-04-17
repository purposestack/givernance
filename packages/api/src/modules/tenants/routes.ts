/** Tenant routes — platform-admin CRUD + self-serve onboarding for organizations */

import { randomBytes } from "node:crypto";
import { outboxEvents, tenants, users } from "@givernance/shared/schema";
import { Type } from "@sinclair/typebox";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db, withTenantContext } from "../../lib/db.js";
import { requireAdminSecret, requireAuth } from "../../lib/guards.js";
import { resolveTranslations } from "../../lib/i18n.js";
import {
  DataArrayResponseNoPagination,
  DataResponse,
  ErrorResponses,
  IdParams,
  ProblemDetailSchema,
  UuidSchema,
} from "../../lib/schemas.js";

const CreateTenantBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  slug: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9-]+$" }),
  plan: Type.Optional(
    Type.Union([Type.Literal("starter"), Type.Literal("pro"), Type.Literal("enterprise")]),
  ),
});

const TenantResponse = Type.Object({
  id: UuidSchema,
  name: Type.String(),
  slug: Type.String(),
  plan: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/** ISO 3166-1 alpha-2 country codes accepted by the onboarding wizard (EU + EEA + CH/GB). */
const CountryCode = Type.Union(
  [
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",
    "GB",
    "CH",
    "NO",
    "IS",
    "LI",
  ].map((c) => Type.Literal(c)),
);

const LegalType = Type.Union([
  Type.Literal("asso1901"),
  Type.Literal("fondation"),
  Type.Literal("frup"),
  Type.Literal("asbl"),
  Type.Literal("ong"),
  Type.Literal("cooperative"),
  Type.Literal("autre"),
]);

const Currency = Type.Union([
  Type.Literal("EUR"),
  Type.Literal("GBP"),
  Type.Literal("CHF"),
  Type.Literal("NOK"),
  Type.Literal("SEK"),
  Type.Literal("DKK"),
  Type.Literal("PLN"),
  Type.Literal("CZK"),
  Type.Literal("HUF"),
  Type.Literal("RON"),
  Type.Literal("BGN"),
]);

const OnboardingBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 255 }),
  country: CountryCode,
  legalType: LegalType,
  currency: Currency,
  registrationNumber: Type.Optional(Type.String({ maxLength: 100 })),
});

const TenantMeResponse = Type.Object({
  id: UuidSchema,
  name: Type.String(),
  slug: Type.String(),
  plan: Type.String(),
  country: Type.Union([Type.String(), Type.Null()]),
  legalType: Type.Union([Type.String(), Type.Null()]),
  currency: Type.String(),
  registrationNumber: Type.Union([Type.String(), Type.Null()]),
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  onboardingCompletedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

/**
 * Resolve the caller's tenant id by inspecting JWT then DB. Returns null when
 * the authenticated user has no tenant yet (first-time sign-in before onboarding
 * — see #40 PR-A4). JWTs issued by Keycloak may omit `org_id` until the claim
 * mapper is wired up in Phase 2; DB lookup via `keycloak_id` is the fallback.
 */
async function resolveCallerOrgId(request: FastifyRequest): Promise<string | null> {
  const fromJwt = request.auth?.orgId;
  if (fromJwt) return fromJwt;

  const userId = request.auth?.userId;
  if (!userId) return null;

  const [row] = await db
    .select({ orgId: users.orgId })
    .from(users)
    .where(eq(users.keycloakId, userId));
  return row?.orgId ?? null;
}

/**
 * Derive a URL-safe slug from an organisation name.
 *
 * 8-byte (64-bit) hex suffix — collision probability stays negligible at
 * realistic tenant scale (birthday bound ~4B inserts to hit 1%). Caller must
 * still handle the unique-violation retry in case of an adversarial collision.
 */
function deriveSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const suffix = randomBytes(8).toString("hex");
  return base ? `${base}-${suffix}` : `org-${suffix}`;
}

export async function tenantRoutes(app: FastifyInstance) {
  /** POST /v1/tenants — create a new organization (platform admin only) */
  app.post(
    "/tenants",
    {
      preHandler: requireAdminSecret,
      schema: {
        tags: ["Tenants"],
        body: CreateTenantBody,
        response: { 201: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; slug: string; plan?: string };

      // Transactional outbox: insert tenant + outbox event in same transaction.
      // outbox_events has FORCE RLS, so we set tenant context within the transaction
      // using the newly created tenant's ID.
      const result = await db.transaction(async (tx) => {
        const [tenant] = await tx
          .insert(tenants)
          .values({ name: body.name, slug: body.slug, plan: body.plan ?? "starter" })
          .returning();

        // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row for single insert
        const t = tenant!;

        // Set RLS context for outbox_events insert (FORCE RLS is active on that table)
        await tx.execute(sql`SELECT set_config('app.current_organization_id', ${t.id}, true)`);
        await tx.insert(outboxEvents).values({
          tenantId: t.id,
          type: "tenant.created",
          payload: { tenantId: t.id, name: t.name, slug: t.slug },
        });

        return tenant;
      });

      return reply.status(201).send({ data: result });
    },
  );

  /** GET /v1/tenants — list all organizations (platform admin only) */
  app.get(
    "/tenants",
    {
      preHandler: requireAdminSecret,
      schema: {
        tags: ["Tenants"],
        response: { 200: DataArrayResponseNoPagination(TenantResponse), ...ErrorResponses },
      },
    },
    async (_request, reply) => {
      const all = await db.select().from(tenants);
      return reply.send({ data: all });
    },
  );

  /**
   * GET /v1/tenants/me — current user's tenant, including onboarding status.
   * Returns 404 when the user has no tenant yet so the web app can route
   * them into the onboarding wizard.
   */
  app.get(
    "/tenants/me",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Tenants"],
        response: { 200: DataResponse(TenantMeResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const orgId = await resolveCallerOrgId(request);
      if (!orgId) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, orgId));
      if (!tenant) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      return reply.send({ data: tenant });
    },
  );

  /**
   * POST /v1/tenants/me/onboarding — self-serve organisation profile save.
   *
   * Create-or-update:
   * - First-time user (no tenant, no DB users row): creates tenant, creates users
   *   row with role=org_admin linked by keycloakId, emits tenant.created outbox event.
   * - Existing tenant: updates the onboarding profile fields.
   *
   * The JWT does not yet get re-issued with the new org_id — downstream requests
   * use the keycloak_id → users table fallback in resolveCallerOrgId. Claim-based
   * org_id propagation is tracked with the Phase 2 multi-tenant work (#78).
   */
  app.post(
    "/tenants/me/onboarding",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Tenants"],
        body: OnboardingBody,
        response: {
          200: DataResponse(TenantMeResponse),
          201: DataResponse(TenantMeResponse),
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId as string;
      const email = request.auth?.email as string | undefined;
      const body = request.body as {
        name: string;
        country: string;
        legalType: string;
        currency: string;
        registrationNumber?: string;
      };

      const existingOrgId = await resolveCallerOrgId(request);

      if (existingOrgId) {
        // Run the tenant UPDATE and the outbox event in the same RLS-scoped
        // transaction. Tenants has no tenant_isolation policy today, but the
        // outbox does, and future-proofing against an RLS rollout on tenants
        // keeps this path atomic.
        const updated = await withTenantContext(existingOrgId, async (tx) => {
          const [row] = await tx
            .update(tenants)
            .set({
              name: body.name,
              country: body.country,
              legalType: body.legalType,
              currency: body.currency,
              registrationNumber: body.registrationNumber ?? null,
              updatedAt: new Date(),
            })
            .where(eq(tenants.id, existingOrgId))
            .returning();

          if (!row) return null;

          await tx.insert(outboxEvents).values({
            tenantId: existingOrgId,
            type: "tenant.onboarding_updated",
            payload: { tenantId: existingOrgId, name: row.name },
          });

          return row;
        });

        if (!updated) {
          const t = resolveTranslations(request);
          return reply.status(404).send({
            type: "https://httpproblems.com/http-status/404",
            title: "Not Found",
            status: 404,
            detail: t("errors.notFound", { resource: t("resources.tenant") }),
          });
        }

        return reply.status(200).send({ data: updated });
      }

      if (!email) {
        const t = resolveTranslations(request);
        return reply.status(401).send({
          type: "https://httpproblems.com/http-status/401",
          title: "Unauthorized",
          status: 401,
          detail: t("errors.unauthorized"),
        });
      }

      // JWT `given_name`/`family_name` are not propagated to request.auth yet —
      // fall back to the email local-part so the users row is creatable. The
      // user can update their profile post-onboarding in Phase 2.
      const firstName = email.split("@")[0] || "User";
      const lastName = "";

      try {
        const bootstrapped = await db.transaction(async (tx) => {
          const [tenant] = await tx
            .insert(tenants)
            .values({
              name: body.name,
              slug: deriveSlug(body.name),
              country: body.country,
              legalType: body.legalType,
              currency: body.currency,
              registrationNumber: body.registrationNumber ?? null,
            })
            .returning();
          // biome-ignore lint/style/noNonNullAssertion: returning() always yields one row
          const t = tenant!;

          await tx.execute(sql`SELECT set_config('app.current_organization_id', ${t.id}, true)`);

          await tx.insert(users).values({
            orgId: t.id,
            email,
            firstName,
            lastName,
            role: "org_admin",
            keycloakId: userId,
          });

          await tx.insert(outboxEvents).values({
            tenantId: t.id,
            type: "tenant.created",
            payload: { tenantId: t.id, name: t.name, slug: t.slug, bootstrappedBy: userId },
          });

          return t;
        });

        return reply.status(201).send({ data: bootstrapped });
      } catch (err) {
        // PostgreSQL unique-violation (SQLSTATE 23505): a concurrent bootstrap
        // already created a tenant for this user. Collapse to the update path
        // rather than 500.
        if ((err as { code?: string } | null)?.code === "23505") {
          request.log.warn({ userId }, "onboarding bootstrap collided with concurrent request");
          const raceOrgId = await resolveCallerOrgId(request);
          if (raceOrgId) {
            const [tenant] = await db.select().from(tenants).where(eq(tenants.id, raceOrgId));
            if (tenant) return reply.status(200).send({ data: tenant });
          }
        }
        throw err;
      }
    },
  );

  /**
   * POST /v1/tenants/me/onboarding/complete — finalise the onboarding wizard.
   * Sets onboarding_completed_at so the web middleware stops routing the user
   * back to /onboarding on subsequent visits. Idempotent: returns the current
   * tenant whether or not the timestamp was already set.
   */
  app.post(
    "/tenants/me/onboarding/complete",
    {
      preHandler: requireAuth,
      schema: {
        tags: ["Tenants"],
        response: {
          200: DataResponse(TenantMeResponse),
          409: ProblemDetailSchema,
          ...ErrorResponses,
        },
      },
    },
    async (request, reply) => {
      const orgId = await resolveCallerOrgId(request);
      if (!orgId) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      const [existing] = await db.select().from(tenants).where(eq(tenants.id, orgId));
      if (!existing) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      if (!existing.country || !existing.legalType || !existing.currency) {
        const t = resolveTranslations(request);
        return reply.status(409).send({
          type: "https://httpproblems.com/http-status/409",
          title: "Conflict",
          status: 409,
          detail: t("errors.onboardingIncomplete"),
        });
      }

      if (existing.onboardingCompletedAt) {
        return reply.status(200).send({ data: existing });
      }

      const now = new Date();
      const updated = await withTenantContext(orgId, async (tx) => {
        const [row] = await tx
          .update(tenants)
          .set({ onboardingCompletedAt: now, updatedAt: now })
          .where(eq(tenants.id, orgId))
          .returning();

        await tx.insert(outboxEvents).values({
          tenantId: orgId,
          type: "tenant.onboarding_completed",
          payload: { tenantId: orgId, completedAt: now.toISOString() },
        });

        return row;
      });

      return reply.status(200).send({ data: updated });
    },
  );

  /** GET /v1/tenants/:id — get organization details (platform admin only) */
  app.get(
    "/tenants/:id",
    {
      preHandler: requireAdminSecret,
      schema: {
        tags: ["Tenants"],
        params: IdParams,
        response: { 200: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));

      if (!tenant) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      return reply.send({ data: tenant });
    },
  );

  /** DELETE /v1/tenants/:id — delete an organization (platform admin only) */
  app.delete(
    "/tenants/:id",
    {
      preHandler: requireAdminSecret,
      schema: {
        tags: ["Tenants"],
        params: IdParams,
        response: { 200: DataResponse(TenantResponse), ...ErrorResponses },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [deleted] = await db.delete(tenants).where(eq(tenants.id, id)).returning();

      if (!deleted) {
        const t = resolveTranslations(request);
        return reply.status(404).send({
          type: "https://httpproblems.com/http-status/404",
          title: "Not Found",
          status: 404,
          detail: t("errors.notFound", { resource: t("resources.tenant") }),
        });
      }

      return reply.status(200).send({ data: deleted });
    },
  );
}
