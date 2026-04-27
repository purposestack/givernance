import { createClientApiClient } from "@/lib/api/client-browser";

export interface DisputeRow {
  id: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  disputerId: string | null;
  provisionalAdminId: string | null;
  reason: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export type DisputeResolution = "kept" | "replaced" | "escalated_to_support";

export interface DomainDisputeRow {
  id: string;
  orgId: string;
  orgSlug: string;
  orgName: string;
  claimerEmail: string;
  claimerFirstName: string | null;
  claimerLastName: string | null;
  reason: string | null;
  state: string;
  resolvedAt: string | null;
  createdAt: string;
}

export type DomainDisputeResolution = "resolved_kept" | "resolved_transferred" | "rejected";

export async function listDisputes(open?: boolean): Promise<DisputeRow[]> {
  const api = createClientApiClient();
  const res = await api.get<{ data: DisputeRow[] }>("/v1/admin/disputes", {
    params: open === undefined ? {} : { open: String(open) },
  });
  return res.data;
}

export async function resolveDisputeApi(id: string, resolution: DisputeResolution): Promise<void> {
  const api = createClientApiClient();
  await api.patch(`/v1/admin/disputes/${id}`, { resolution });
}

export async function listDomainDisputes(open?: boolean): Promise<DomainDisputeRow[]> {
  const api = createClientApiClient();
  const res = await api.get<{ data: DomainDisputeRow[] }>("/v1/admin/domain-disputes", {
    params: open === undefined ? {} : { open: String(open) },
  });
  return res.data;
}

export async function resolveDomainDisputeApi(
  id: string,
  state: DomainDisputeResolution,
): Promise<void> {
  const api = createClientApiClient();
  await api.patch(`/v1/admin/domain-disputes/${id}`, { state });
}
