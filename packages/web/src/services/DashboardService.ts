import type { ApiClient } from "@/lib/api";
import type { DashboardStats, DashboardStatsResponse } from "@/models/dashboard";

export const DashboardService = {
  async getStats(client: ApiClient): Promise<DashboardStats> {
    const response = await client.get<DashboardStatsResponse>("/v1/dashboard/stats");
    return response.data;
  },
};
