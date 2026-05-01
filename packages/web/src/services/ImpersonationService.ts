import type { ApiClient } from "@/lib/api";
import type { ImpersonationModeName } from "@/lib/auth/verify-impersonation-jwt";

/**
 * ImpersonationService — ADR-011 Layer 2.
 *
 * Wraps the support-session endpoints (`/v1/admin/impersonation`) for both
 * admin pages (list / detail) and the start-session client form. The two
 * coexisting modes — `delegation` and `impersonation` — pick at start
 * time; the API enforces the mode-specific behaviour, this service is
 * just the transport.
 */

export interface ImpersonationSessionDTO {
  id: string;
  impersonatorKeycloakId: string;
  targetKeycloakId: string;
  targetOrgId: string;
  targetRole: string;
  mode: ImpersonationModeName;
  reason: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  ipHash: string | null;
  userAgent: string | null;
  createdAt: string;
  isActive: boolean;
}

export interface StartSessionInput {
  targetUserId: string;
  mode: ImpersonationModeName;
  reason: string;
}

export interface StartSessionResponse {
  sessionId: string;
  mode: ImpersonationModeName;
  expiresAt: string;
  token: string;
  targetOrgId: string;
  targetUserId: string;
}

export interface ImpersonationTargetCandidate {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  keycloakId: string | null;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
}

export interface ImpersonationTenantOption {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export const ImpersonationService = {
  async listSessions(
    client: ApiClient,
    opts: { all?: boolean; limit?: number } = {},
  ): Promise<{ data: ImpersonationSessionDTO[] }> {
    return client.get("/v1/admin/impersonation", {
      params: {
        all: opts.all ? true : undefined,
        limit: opts.limit,
      },
    });
  },

  async getSession(
    client: ApiClient,
    sessionId: string,
  ): Promise<{ data: ImpersonationSessionDTO }> {
    return client.get(`/v1/admin/impersonation/${encodeURIComponent(sessionId)}`);
  },

  async startSession(
    client: ApiClient,
    input: StartSessionInput,
  ): Promise<{ data: StartSessionResponse }> {
    return client.post("/v1/admin/impersonation", input);
  },

  async endSession(client: ApiClient, sessionId: string): Promise<void> {
    await client.delete(`/v1/admin/impersonation/${encodeURIComponent(sessionId)}`);
  },

  async revokeAllForUser(
    client: ApiClient,
    targetUserId: string,
  ): Promise<{ data: { revokedSessionIds: string[] } }> {
    return client.delete(`/v1/admin/impersonation/user/${encodeURIComponent(targetUserId)}`);
  },

  async searchTargets(
    client: ApiClient,
    opts: { q?: string; tenantId?: string; limit?: number } = {},
  ): Promise<{ data: ImpersonationTargetCandidate[] }> {
    return client.get("/v1/admin/impersonation/targets", {
      params: {
        q: opts.q,
        tenantId: opts.tenantId,
        limit: opts.limit,
      },
    });
  },

  async listTenants(client: ApiClient, q?: string): Promise<{ data: ImpersonationTenantOption[] }> {
    return client.get("/v1/admin/impersonation/tenants", {
      params: { q },
    });
  },

  async getSessionAudit(
    client: ApiClient,
    sessionId: string,
  ): Promise<{
    data: Array<{
      id: string;
      orgId: string;
      userId: string | null;
      actorId: string | null;
      impersonationMode: string | null;
      action: string;
      resourceType: string | null;
      resourceId: string | null;
      ipHash: string | null;
      userAgent: string | null;
      createdAt: string;
    }>;
  }> {
    return client.get(`/v1/admin/impersonation/${encodeURIComponent(sessionId)}/audit`);
  },
};
