import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import InviteAcceptPage from "./page";

const TOKEN = "00000000-0000-0000-0000-000000000123";

// Override the global setup mock so the page sees a token in the query
// string. The setup.tsx mock returns an empty URLSearchParams which would
// route the page into its missing-token branch.
vi.mock("next/navigation", async () => {
  const { mockRouter } = await import("@/tests/mocks");
  return {
    useRouter: () => mockRouter,
    usePathname: () => "/invite/accept",
    useSearchParams: () => new URLSearchParams(`token=${TOKEN}`),
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * URL-routing fetch mock — the page fires multiple parallel calls
 * (session probe, token probe, accept POST) so a `mockResolvedValueOnce`
 * sequence is brittle to call order. This dispatches by URL substring +
 * method so each test only declares the responses it cares about.
 */
type RouteFn = () => Response | Promise<Response>;

const DEFAULT_SESSION: RouteFn = () => new Response(null, { status: 401 });
const DEFAULT_PROBE: RouteFn = () => new Response(null, { status: 204 });
const DEFAULT_ACCEPT: RouteFn = () =>
  new Response(JSON.stringify({ data: { slug: "test-slug" } }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });

function pickRoute(
  url: string,
  method: string,
  routes: { session?: RouteFn; probe?: RouteFn; accept?: RouteFn },
): RouteFn {
  if (url.includes("/v1/users/me")) return routes.session ?? DEFAULT_SESSION;
  if (url.includes("/probe")) return routes.probe ?? DEFAULT_PROBE;
  if (url.includes("/accept") && method === "POST") return routes.accept ?? DEFAULT_ACCEPT;
  throw new Error(`Unhandled fetch in test: ${method} ${url}`);
}

function stubRoutedFetch(routes: { session?: RouteFn; probe?: RouteFn; accept?: RouteFn }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    return pickRoute(url, method, routes)();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("InviteAcceptPage — session-detection prompt", () => {
  it("renders the sign-out prompt when /v1/users/me returns a signed-in user", async () => {
    stubRoutedFetch({
      session: () =>
        new Response(
          JSON.stringify({
            data: { email: "alice@example.org", firstName: "Alice", lastName: "Martin" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      probe: () => new Response(null, { status: 204 }),
    });

    render(<InviteAcceptPage />);

    const heading = await screen.findByRole("heading", {
      name: "Sign out to accept this invitation",
    });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText(/Alice Martin/)).toBeInTheDocument();
    expect(screen.getByText(/alice@example\.org/)).toBeInTheDocument();

    // The form posts to the logout route with the return_to round-trip
    // baked in so Keycloak lands the invitee back on this page.
    const submit = screen.getByRole("button", { name: "Sign out and continue" });
    const form = submit.closest("form");
    expect(form?.getAttribute("action")).toBe("/api/auth/logout");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    const hidden = form?.querySelector('input[name="return_to"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe(`/invite/accept?token=${TOKEN}`);
  });

  it("renders the accept form when /v1/users/me returns 401", async () => {
    stubRoutedFetch({}); // defaults: session 401, probe 204

    render(<InviteAcceptPage />);

    expect(await screen.findByRole("button", { name: /Join workspace/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out and continue" })).not.toBeInTheDocument();
  });

  it("renders the accept form when /v1/users/me throws (network error)", async () => {
    stubRoutedFetch({
      session: () => {
        throw new Error("network down");
      },
    });

    render(<InviteAcceptPage />);

    expect(await screen.findByRole("button", { name: /Join workspace/ })).toBeInTheDocument();
  });
});

describe("InviteAcceptPage — token probe (PR #154 follow-up)", () => {
  it("short-circuits to the terminal screen when the probe returns 410", async () => {
    stubRoutedFetch({
      probe: () =>
        new Response(JSON.stringify({ detail: "expired" }), {
          status: 410,
          headers: { "Content-Type": "application/json" },
        }),
    });

    render(<InviteAcceptPage />);

    // No form, no signed-in prompt — straight to the terminal screen.
    await screen.findByRole("link", { name: "Back to sign in" });
    expect(screen.queryByRole("button", { name: /Join workspace/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out and continue" })).not.toBeInTheDocument();
    expect(screen.getByText(/invitation link is invalid/i)).toBeInTheDocument();
  });

  it("treats probe network failure as valid so the form still renders", async () => {
    stubRoutedFetch({
      probe: () => {
        throw new Error("network down");
      },
    });

    render(<InviteAcceptPage />);

    expect(await screen.findByRole("button", { name: /Join workspace/ })).toBeInTheDocument();
  });

  it("treats probe 429 (rate-limited) as valid so the form still renders", async () => {
    stubRoutedFetch({
      probe: () => new Response(null, { status: 429 }),
    });

    render(<InviteAcceptPage />);

    expect(await screen.findByRole("button", { name: /Join workspace/ })).toBeInTheDocument();
  });

  it("terminal screen takes precedence over the signed-in prompt", async () => {
    stubRoutedFetch({
      session: () =>
        new Response(JSON.stringify({ data: { email: "alice@example.org" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      probe: () => new Response(null, { status: 410 }),
    });

    render(<InviteAcceptPage />);

    await screen.findByRole("link", { name: "Back to sign in" });
    expect(screen.queryByRole("button", { name: "Sign out and continue" })).not.toBeInTheDocument();
  });
});

describe("InviteAcceptPage — terminal-error screen (post-submit race)", () => {
  it("swaps the form for a back-to-login screen when the API returns 410 on submit", async () => {
    const user = userEvent.setup();
    stubRoutedFetch({
      probe: () => new Response(null, { status: 204 }),
      accept: () =>
        new Response(JSON.stringify({ detail: "expired" }), {
          status: 410,
          headers: { "Content-Type": "application/json" },
        }),
    });

    render(<InviteAcceptPage />);

    // Label primitives append a `*` to required fields → use regex matchers.
    await user.type(await screen.findByLabelText(/First name/), "Alice");
    await user.type(screen.getByLabelText(/Last name/), "Martin");
    await user.type(screen.getByLabelText(/Choose a password/), "ten-char-password!");
    await user.type(screen.getByLabelText(/Confirm password/), "ten-char-password!");
    await user.click(screen.getByRole("button", { name: /Join workspace/ }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Join workspace/ })).not.toBeInTheDocument();
    });
    expect(screen.getByText(/invitation link is invalid/i)).toBeInTheDocument();
    const backLink = screen.getByRole("link", { name: "Back to sign in" });
    expect(backLink).toHaveAttribute("href", "/login");
  });
});
