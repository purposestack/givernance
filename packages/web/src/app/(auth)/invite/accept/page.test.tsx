import { render, screen } from "@testing-library/react";
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

describe("InviteAcceptPage — session-detection prompt", () => {
  it("renders the sign-out prompt when /v1/users/me returns a signed-in user", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: { email: "alice@example.org", firstName: "Alice", lastName: "Martin" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    render(<InviteAcceptPage />);

    // The form's submit button is the discriminator vs the prompt's button
    // ("Join workspace & sign in" only renders in the form branch).
    expect(await screen.findByRole("button", { name: /Join workspace/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out and continue" })).not.toBeInTheDocument();
  });

  it("renders the accept form when /v1/users/me throws (network error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    render(<InviteAcceptPage />);

    expect(await screen.findByRole("button", { name: /Join workspace/ })).toBeInTheDocument();
  });
});
