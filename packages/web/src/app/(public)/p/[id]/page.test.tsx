import { render, screen } from "@/tests/test-utils";

import PublicCampaignPage from "./page";

const getPublishedCampaignPublicPage = vi.fn();

vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () => (key: string) =>
    ({
      backHome: "Back home",
      badge: "Secure donation page",
      eyebrow: "Campaign",
      descriptionFallback: "Fallback description",
      "metrics.goal": "Goal",
      "metrics.trust": "Trust",
      "metrics.trustValue": "Trusted checkout",
    })[key] ?? key,
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

vi.mock("@/lib/api/client-server", () => ({
  createServerApiClient: async () => ({}),
}));

vi.mock("@/services/CampaignPublicPageService", () => ({
  CampaignPublicPageService: {
    getPublishedCampaignPublicPage: (...args: unknown[]) => getPublishedCampaignPublicPage(...args),
  },
}));

vi.mock("@/components/campaigns/public-donation-form", () => ({
  PublicDonationForm: () => <div data-testid="public-donation-form" />,
}));

describe("PublicCampaignPage", () => {
  it("hides the goal metric when the configured goal is 0 EUR", async () => {
    getPublishedCampaignPublicPage.mockResolvedValue({
      title: "Spring appeal",
      description: "Support the mission",
      goalAmountCents: 0,
      colorPrimary: "#096447",
      defaultCurrency: "EUR",
    });

    render(
      await PublicCampaignPage({
        params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000123" }),
      }),
    );

    expect(screen.queryByText("Goal")).not.toBeInTheDocument();
    expect(screen.getByText("Trust")).toBeInTheDocument();
  });
});
