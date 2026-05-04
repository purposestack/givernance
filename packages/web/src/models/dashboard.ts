export interface DashboardPeriod {
  current: number;
  previous: number;
}

export interface DashboardStats {
  totalRaisedCents: DashboardPeriod;
  newDonors: DashboardPeriod;
  newActiveCampaigns: DashboardPeriod;
  /** ISO-4217 code of the tenant's base currency for totalRaisedCents */
  baseCurrency: string;
}

export interface DashboardStatsResponse {
  data: DashboardStats;
}
