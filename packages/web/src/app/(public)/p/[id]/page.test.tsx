import { render, screen } from "@/tests/test-utils";

import PublicCampaignPage, { generateMetadata } from "./page";

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

// Renders only what the page hands it, so the tests can see the `fallback`.
vi.mock("@/components/campaigns/archetype-renderer", () => ({
  ArchetypeRenderer: ({ fallback }: { fallback?: React.ReactNode }) => (
    <div data-testid="archetype-renderer">{fallback}</div>
  ),
}));

const CAMPAIGN_ID = "00000000-0000-0000-0000-000000000123";

describe("PublicCampaignPage", () => {
  it("hides the goal metric when the configured goal is 0 EUR", async () => {
    getPublishedCampaignPublicPage.mockResolvedValue({
      title: "Spring appeal",
      description: "Support the mission",
      goalAmountCents: 0,
      colorPrimary: "#08675b",
      defaultCurrency: "EUR",
    });

    render(
      await PublicCampaignPage({
        params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000123" }),
        searchParams: Promise.resolve({}),
      }),
    );

    expect(screen.queryByText("Goal")).not.toBeInTheDocument();
    expect(screen.getByText("Trust")).toBeInTheDocument();
  });

  // ─── Issue #615 ─────────────────────────────────────────────────────────

  it("gives the skip link a single <main id='main-content'> on the hardcoded layout", async () => {
    getPublishedCampaignPublicPage.mockResolvedValue({
      title: "Spring appeal",
      description: "Support the mission",
      goalAmountCents: null,
      colorPrimary: "#08675b",
      defaultCurrency: "EUR",
    });

    render(
      await PublicCampaignPage({
        params: Promise.resolve({ id: CAMPAIGN_ID }),
        searchParams: Promise.resolve({}),
      }),
    );

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]).toHaveAttribute("id", "main-content");
  });

  it("hands the archetype renderer the hardcoded layout as its fallback, inside the same single <main>", async () => {
    getPublishedCampaignPublicPage.mockResolvedValue({
      title: "Spring appeal",
      description: "Support the mission",
      goalAmountCents: null,
      colorPrimary: "#08675b",
      defaultCurrency: "EUR",
      publicPageStyle: "activist",
    });

    render(
      await PublicCampaignPage({
        params: Promise.resolve({ id: CAMPAIGN_ID }),
        searchParams: Promise.resolve({}),
      }),
    );

    const mains = screen.getAllByRole("main");
    expect(mains).toHaveLength(1);
    expect(mains[0]).toHaveAttribute("id", "main-content");

    // The fallback is a complete donation page: headline + working form.
    const renderer = screen.getByTestId("archetype-renderer");
    expect(renderer).toContainElement(screen.getByRole("heading", { name: "Spring appeal" }));
    expect(renderer).toContainElement(screen.getByTestId("public-donation-form"));
  });
});

describe("generateMetadata", () => {
  const PAGE = {
    title: "Spring appeal",
    description: "Support the mission",
    organisationName: "Acme Relief",
    organisationLogoUrl: "https://s3.fr-par.scw.cloud/branding/acme/logo.png",
    goalAmountCents: null,
    colorPrimary: "#08675b",
    defaultCurrency: "EUR",
  };

  it("describes the campaign with Open Graph tags and a canonical URL", async () => {
    getPublishedCampaignPublicPage.mockResolvedValue(PAGE);

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: CAMPAIGN_ID }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata.description).toBe("Support the mission");
    expect(metadata.alternates).toEqual({ canonical: `/p/${CAMPAIGN_ID}` });
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      description: "Support the mission",
      url: `/p/${CAMPAIGN_ID}`,
      siteName: "Acme Relief",
      images: [{ url: PAGE.organisationLogoUrl }],
    });
    expect(metadata.robots).toBeUndefined();
  });

  it.each([
    ["style", { style: "cosmic-gradient" }],
    ["qr", { qr: "abcDEF123456" }],
  ])("marks the ?%s= variant noindex and keeps it out of the canonical URL", async (_name, sp) => {
    getPublishedCampaignPublicPage.mockResolvedValue(PAGE);

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: CAMPAIGN_ID }),
      searchParams: Promise.resolve(sp),
    });

    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates).toEqual({ canonical: `/p/${CAMPAIGN_ID}` });
  });

  it("returns a neutral noindex title instead of throwing when the campaign is not published", async () => {
    getPublishedCampaignPublicPage.mockRejectedValue(new Error("404"));

    const metadata = await generateMetadata({
      params: Promise.resolve({ id: CAMPAIGN_ID }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata.title).toBe("metadata.unavailableTitle");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
