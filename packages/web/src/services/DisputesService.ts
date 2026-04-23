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
