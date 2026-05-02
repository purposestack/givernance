import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import PlatformAdminAcceptPage from "./page";

const TOKEN = "00000000-0000-0000-0000-000000000abc";

vi.mock("next/navigation", async () => {
  const { mockRouter } = await import("@/tests/mocks");
  return {
    useRouter: () => mockRouter,
    usePathname: () => "/admin/platform-admins/accept",
    useSearchParams: () => new URLSearchParams(`token=${TOKEN}`),
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type RouteFn = () => Response | Promise<Response>;

const DEFAULT_SESSION: RouteFn = () => new Response(null, { status: 401 });
const DEFAULT_PROBE: RouteFn = () =>
  new Response(
    JSON.stringify({
      data: { email: "new@example.org", firstName: "New", lastName: "Admin" },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

function pickRoute(url: string, routes: { session?: RouteFn; probe?: RouteFn }): RouteFn {
  if (url.includes("/v1/users/me")) return routes.session ?? DEFAULT_SESSION;
  if (url.includes("/v1/public/platform-admins/invitations/")) {
    return routes.probe ?? DEFAULT_PROBE;
  }
  throw new Error(`Unhandled fetch in test: ${url}`);
}

function stubRoutedFetch(routes: { session?: RouteFn; probe?: RouteFn }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return pickRoute(url, routes)();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("PlatformAdminAcceptPage — session-conflict prompt round-trip", () => {
  it("renders the sign-out prompt when /v1/users/me returns a signed-in user", async () => {
    stubRoutedFetch({
      session: () =>
        new Response(
          JSON.stringify({
            data: { email: "alice@example.org", firstName: "Alice", lastName: "Martin" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    render(<PlatformAdminAcceptPage />);

    const heading = await screen.findByRole("heading", {
      name: "Sign out to accept this invitation",
    });
    expect(heading).toBeInTheDocument();
  });

  /**
   * Locks the return_to round-trip used by `/api/auth/logout`. Without
   * this, regressing the path could silently route the post-logout
   * redirect to `/login` (the route's allowlist fallback) — the exact
   * UX bug surfaced in dev: the invitee signed out, lost the token in
   * the URL, and got bounced to login with no password set yet.
   *
   * The route's allowlist test (in `route.test.ts`) covers the
   * server-side guard; this test covers the client-side input.
   */
  it("submits return_to=/admin/platform-admins/accept?token=... to /api/auth/logout", async () => {
    stubRoutedFetch({
      session: () =>
        new Response(
          JSON.stringify({
            data: { email: "alice@example.org", firstName: "Alice", lastName: "Martin" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    render(<PlatformAdminAcceptPage />);

    const submit = await screen.findByRole("button", { name: "Sign out and continue" });
    const form = submit.closest("form");
    expect(form?.getAttribute("action")).toBe("/api/auth/logout");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    const hidden = form?.querySelector('input[name="return_to"]') as HTMLInputElement | null;
    expect(hidden?.value).toBe(`/admin/platform-admins/accept?token=${TOKEN}`);
  });

  it("renders the password-set form when /v1/users/me returns 401", async () => {
    stubRoutedFetch({});
    render(<PlatformAdminAcceptPage />);

    expect(
      await screen.findByRole("button", { name: /Create my admin account/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out and continue" })).not.toBeInTheDocument();
  });

  it("renders the expired/invalid screen when the token probe returns 404", async () => {
    stubRoutedFetch({ probe: () => new Response(null, { status: 404 }) });
    render(<PlatformAdminAcceptPage />);

    expect(await screen.findByRole("heading", { name: /Invitation problem/ })).toBeInTheDocument();
  });
});
