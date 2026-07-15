/**
 * CommandPalette tests — covers the stateful surface added by Epic
 * #364 (GLO-001): debounce, AbortController supersede, RBAC gating on
 * quick-create rows, render branches.
 *
 * Mocks `SearchService.search` (so tests don't need a server),
 * `next/navigation`'s `useRouter` (so `router.push` is observable), and
 * `useAuth` (so role coverage is parametrised per test). The Dialog
 * uses Radix portals; Testing Library renders portals into the JSDOM
 * body by default so queries work.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, userEvent, waitFor } from "@/tests/test-utils";

const mockSearch = vi.fn();
const mockRouterPush = vi.fn();
const mockHasAppRole = vi.fn();

vi.mock("@/services/SearchService", () => ({
  SearchService: {
    search: (...args: unknown[]) => mockSearch(...args),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: () => ({}),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    hasAppRole: mockHasAppRole,
  }),
}));

const { CommandPalette } = await import("./command-palette");

const ONE_HIT_RESULT = {
  query: "marie",
  groups: {
    constituents: [
      {
        type: "constituent" as const,
        id: "11111111-1111-1111-1111-111111111111",
        title: "Marie Fontaine",
        subtitle: "donor · Marseille",
        href: "/constituents/11111111-1111-1111-1111-111111111111",
      },
    ],
    campaigns: [],
    donations: [],
  },
};

beforeEach(() => {
  mockSearch.mockReset();
  mockRouterPush.mockReset();
  mockHasAppRole.mockReset();
  // Default: org_admin role so quick-create rows render. Per-test
  // overrides flip to "viewer" for the role-coverage check.
  mockHasAppRole.mockImplementation((role: string) => role === "org_admin");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CommandPalette — empty-state surfaces", () => {
  it("renders static Go-to and Quick-create rows for an org_admin", () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    // Navigation rows visible.
    expect(screen.getByRole("option", { name: /go to dashboard/i })).toBeDefined();
    expect(screen.getByRole("option", { name: /go to constituents/i })).toBeDefined();
    expect(screen.getByRole("option", { name: /go to campaigns/i })).toBeDefined();
    expect(screen.getByRole("option", { name: /go to donations/i })).toBeDefined();
    // Quick-create rows visible (org_admin → canWrite=true).
    expect(screen.getByRole("option", { name: /new constituent/i })).toBeDefined();
    expect(screen.getByRole("option", { name: /record a donation/i })).toBeDefined();
    expect(screen.getByRole("option", { name: /new campaign/i })).toBeDefined();
  });

  it("hides quick-create rows for a viewer (RBAC parity, both directions)", () => {
    mockHasAppRole.mockImplementation(() => false);
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("option", { name: /go to dashboard/i })).toBeDefined();
    expect(screen.queryByRole("option", { name: /new constituent/i })).toBeNull();
    expect(screen.queryByRole("option", { name: /record a donation/i })).toBeNull();
    expect(screen.queryByRole("option", { name: /new campaign/i })).toBeNull();
  });

  it("shows quick-create rows for a user role (the other positive case)", () => {
    mockHasAppRole.mockImplementation((role: string) => role === "user");
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    expect(screen.getByRole("option", { name: /new constituent/i })).toBeDefined();
  });
});

describe("CommandPalette — empty-state entrance cascade (ADR-035 D16/B12)", () => {
  it("staggers the empty-state groups via .cascade on open", () => {
    const { baseElement } = render(<CommandPalette open={true} onClose={vi.fn()} />);
    // Radix portals into the body, so query from baseElement.
    expect(baseElement.querySelector(".cascade")).not.toBeNull();
  });

  it("drops the cascade after the first keystroke and never replays it (rule B12)", () => {
    const { baseElement } = render(<CommandPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;

    // One character: below MIN_QUERY_LENGTH, so the empty state is
    // still rendered — but the hasTyped latch must already have
    // dropped the entrance class.
    fireEvent.change(input, { target: { value: "m" } });
    expect(baseElement.querySelector(".cascade")).toBeNull();

    // Clearing back to the empty state must NOT restore the cascade:
    // returning mid-session is instant, entrances play once per open.
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByRole("option", { name: /go to dashboard/i })).toBeDefined();
    expect(baseElement.querySelector(".cascade")).toBeNull();
  });
});

describe("CommandPalette — debounce + search", () => {
  // Note: these tests use REAL timers and the actual 200 ms debounce.
  // user-event + fake timers + Radix Dialog's internal effects deadlock
  // each other; falling back to `fireEvent.change` + waitFor on the
  // mock-call assertion is more reliable and only adds ~250 ms per test.

  it("does NOT call SearchService.search for a 1-char query (MIN_QUERY_LENGTH=2)", async () => {
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "m" } });
    // Wait past the debounce window; mock must remain uncalled.
    await new Promise((res) => setTimeout(res, 300));
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("debounces the fetch and only fires the latest keystroke", async () => {
    mockSearch.mockResolvedValue(ONE_HIT_RESULT);
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ma" } });
    fireEvent.change(input, { target: { value: "mar" } });
    fireEvent.change(input, { target: { value: "mari" } });
    await waitFor(
      () => {
        expect(mockSearch).toHaveBeenCalledTimes(1);
      },
      { timeout: 1000 },
    );
    expect(mockSearch).toHaveBeenCalledWith(expect.anything(), "mari", expect.anything());
  });

  it("renders the loading state while the fetch is in flight", async () => {
    let resolveFetch: (v: typeof ONE_HIT_RESULT) => void = () => {};
    mockSearch.mockReturnValue(
      new Promise<typeof ONE_HIT_RESULT>((res) => {
        resolveFetch = res;
      }),
    );
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "marie" } });
    // Loading message arrives after the debounce window elapses.
    await waitFor(() => {
      expect(screen.getByText(/searching/i)).toBeDefined();
    });
    // Resolve so the in-flight promise doesn't leak past the test.
    resolveFetch(ONE_HIT_RESULT);
  });

  it("renders the error branch when SearchService rejects (non-abort)", async () => {
    mockSearch.mockRejectedValue(new Error("boom"));
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "marie" } });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
  });
});

describe("CommandPalette — selection navigates and closes", () => {
  it("calls onClose() before router.push when a navigation row is selected", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<CommandPalette open={true} onClose={onClose} />);
    await user.click(screen.getByRole("option", { name: /go to dashboard/i }));
    expect(onClose).toHaveBeenCalled();
    expect(mockRouterPush).toHaveBeenCalledWith("/dashboard");
    // Order matters: close FIRST so the overlay isn't visible on top
    // of the destination page.
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      mockRouterPush.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("quick-create routes go to /<entity>/new (not ?new=1)", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open={true} onClose={vi.fn()} />);
    await user.click(screen.getByRole("option", { name: /new constituent/i }));
    expect(mockRouterPush).toHaveBeenCalledWith("/constituents/new");
  });
});
