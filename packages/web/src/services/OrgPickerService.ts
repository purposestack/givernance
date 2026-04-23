/**
 * Browser service for the org picker + switch-org flow (issue #112 / ADR-016).
 *
 * Keeps the page components free of raw fetch + CSRF plumbing. All mutations
 * use `createBrowserFetch()` under the hood, which attaches the CSRF token.
 */

import { createClientApiClient } from "@/lib/api/client-browser";

export interface OrgMembership {
  orgId: string;
  slug: string;
  name: string;
  status: string;
  role: string;
  firstAdmin: boolean;
  provisionalUntil: string | null;
  primaryDomain: string | null;
  lastVisitedAt: string | null;
}

export async function listMyOrganizations(): Promise<OrgMembership[]> {
  const api = createClientApiClient();
  const res = await api.get<{ data: OrgMembership[] }>("/v1/users/me/organizations");
  return res.data;
}

export async function switchOrg(targetOrgId: string): Promise<{
  targetSlug: string;
  targetRole: string;
}> {
  const api = createClientApiClient();
  const res = await api.post<{
    data: { targetOrgId: string; targetSlug: string; targetRole: string };
  }>("/v1/session/switch-org", { targetOrgId });
  return { targetSlug: res.data.targetSlug, targetRole: res.data.targetRole };
}
