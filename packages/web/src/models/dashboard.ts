export interface DashboardPeriod {
  current: number;
  previous: number;
}

export interface DashboardStats {
  totalRaisedCents: DashboardPeriod;
  newDonors: DashboardPeriod;
  newActiveCampaigns: DashboardPeriod;
}

export interface DashboardStatsResponse {
  data: DashboardStats;
}
