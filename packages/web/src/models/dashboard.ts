export interface DashboardPeriod {
  current: number;
  previous: number;
}

export interface MultiCurrencyTotal {
  totalDisplayCents: number;
  displayCurrency: string;
  exchangeRateTimestamp: string | null;
}

export interface DashboardStats {
  totalRaisedCents: DashboardPeriod;
  newDonors: DashboardPeriod;
  newActiveCampaigns: DashboardPeriod;
  multiCurrencyTotal?: MultiCurrencyTotal;
}

export interface DashboardStatsResponse {
  data: DashboardStats;
}
