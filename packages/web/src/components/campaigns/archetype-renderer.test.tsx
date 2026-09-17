import type { ArchetypeModule, ArchetypePageData } from "@/archetypes/types";
import { ArchetypeRenderer } from "@/components/campaigns/archetype-renderer";
import { render, screen, userEvent, waitFor } from "../../tests/test-utils";

// Issue #615 — the `fallback` prop is the donor-protection path. The
// registry is mocked so each test decides whether the slot bundle lands,
// fails, or is still in flight.
const { mockLoadArchetype } = vi.hoisted(() => ({ mockLoadArchetype: vi.fn() }));

vi.mock("@/archetypes/registry", () => ({
  loadArchetype: (...args: unknown[]) => mockLoadArchetype(...args),
}));

const DATA: ArchetypePageData = {
  campaignId: "11111111-1111-4111-8111-111111111111",
  title: "Spring appeal",
  description: null,
  colorPrimary: "#08675b",
  goalAmountCents: 50000,
  raisedCents: 1000,
  donorCount: 3,
  defaultCurrency: "EUR",
  organisationName: "Acme Relief",
  organisationMission: null,
  organisationLogoUrl: null,
  publicPageStyle: "activist",
};

const ARCHETYPE: ArchetypeModule = {
  key: "activist",
  Hero: () => <div data-testid="archetype-hero" />,
  Progress: () => null,
  AmountPicker: ({ formNode }) => <div data-testid="archetype-picker">{formNode}</div>,
  Footer: () => null,
};

const FALLBACK = (
  <div data-testid="hardcoded-layout">
    <input aria-label="Fallback first name" />
  </div>
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ArchetypeRenderer fallback", () => {
  beforeEach(() => {
    mockLoadArchetype.mockReset();
  });

  it("keeps the fallback in the DOM but held back while the slot bundle is loading", () => {
    mockLoadArchetype.mockReturnValue(deferred<ArchetypeModule>().promise);

    render(
      <ArchetypeRenderer styleKey="activist" data={DATA} formNode={null} fallback={FALLBACK} />,
    );

    const fallback = screen.getByTestId("hardcoded-layout");
    expect(fallback.parentElement).toHaveClass("archetype-fallback-pending");
    expect(screen.queryByTestId("archetype-hero")).not.toBeInTheDocument();
  });

  it("swaps the fallback for the archetype once the slot bundle lands", async () => {
    mockLoadArchetype.mockResolvedValue(ARCHETYPE);

    render(
      <ArchetypeRenderer
        styleKey="activist"
        data={DATA}
        formNode={<div data-testid="donation-form" />}
        fallback={FALLBACK}
      />,
    );

    expect(await screen.findByTestId("archetype-hero")).toBeInTheDocument();
    expect(screen.getByTestId("donation-form")).toBeInTheDocument();
    expect(screen.queryByTestId("hardcoded-layout")).not.toBeInTheDocument();
  });

  it("shows the fallback immediately — not held back — when the slot bundle fails to load", async () => {
    mockLoadArchetype.mockRejectedValue(new Error("ChunkLoadError"));

    render(
      <ArchetypeRenderer styleKey="activist" data={DATA} formNode={null} fallback={FALLBACK} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("hardcoded-layout").parentElement).not.toHaveClass(
        "archetype-fallback-pending",
      ),
    );
    expect(screen.queryByTestId("archetype-hero")).not.toBeInTheDocument();
  });

  it("does not yank the fallback away once the donor is using its form", async () => {
    const user = userEvent.setup();
    const pending = deferred<ArchetypeModule>();
    mockLoadArchetype.mockReturnValue(pending.promise);

    render(
      <ArchetypeRenderer styleKey="activist" data={DATA} formNode={null} fallback={FALLBACK} />,
    );

    await user.type(screen.getByLabelText("Fallback first name"), "Jane");
    pending.resolve(ARCHETYPE);

    await waitFor(() =>
      expect(screen.getByTestId("hardcoded-layout").parentElement).not.toHaveClass(
        "archetype-fallback-pending",
      ),
    );
    expect(screen.getByLabelText("Fallback first name")).toHaveValue("Jane");
    expect(screen.queryByTestId("archetype-hero")).not.toBeInTheDocument();
  });

  it("settles on the fallback on a Stripe return so the payment outcome is not lost to a second form instance", async () => {
    const originalSearch = window.location.search;
    window.history.replaceState(
      {},
      "",
      "?payment_intent_client_secret=pi_secret&redirect_status=succeeded",
    );
    mockLoadArchetype.mockResolvedValue(ARCHETYPE);

    render(
      <ArchetypeRenderer styleKey="activist" data={DATA} formNode={null} fallback={FALLBACK} />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("hardcoded-layout").parentElement).not.toHaveClass(
        "archetype-fallback-pending",
      ),
    );
    expect(mockLoadArchetype).not.toHaveBeenCalled();

    window.history.replaceState({}, "", `${window.location.pathname}${originalSearch}`);
  });

  it("renders nothing while loading when no fallback is given (campaign-editor preview)", () => {
    mockLoadArchetype.mockReturnValue(deferred<ArchetypeModule>().promise);

    const { container } = render(
      <ArchetypeRenderer styleKey="activist" data={DATA} formNode={null} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
