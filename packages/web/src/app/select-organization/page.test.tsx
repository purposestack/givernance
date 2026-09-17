/**
 * Org picker interstitial — fetch failure vs. empty membership list
 * (issue #613).
 *
 * Before the fix a failed `/v1/users/me/organizations` call left
 * `memberships = []`, which is indistinguishable from "this user has no
 * tenant" and redirected a valid member to `/login?error=no_tenants`.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProblem } from "@/lib/api";

vi.mock("server-only", () => ({}));

const getMock = vi.fn();

class RedirectSignal extends Error {
  constructor(readonly target: string) {
    super(`NEXT_REDIRECT ${target}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (target: string) => {
    throw new RedirectSignal(target);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "givernance_jwt" ? { value: "jwt" } : undefined),
  }),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

vi.mock("@/lib/api/client-server", () => ({
  createServerApiClient: async () => ({ get: (...args: unknown[]) => getMock(...args) }),
}));

vi.mock("@/components/auth/org-picker", () => ({
  OrgPickerClient: ({ memberships }: { memberships: unknown[] }) => (
    <div data-testid="org-picker">{memberships.length}</div>
  ),
}));

function membership(orgId: string) {
  return {
    orgId,
    slug: orgId,
    name: orgId,
    status: "active",
    role: "user",
    firstAdmin: false,
    provisionalUntil: null,
    primaryDomain: null,
    lastVisitedAt: null,
  };
}

async function loadPage() {
  const { default: SelectOrganizationPage } = await import("./page");
  return SelectOrganizationPage();
}

beforeEach(() => {
  getMock.mockReset();
});

describe("SelectOrganizationPage", () => {
  it("renders an error card with a reload retry when the API call fails", async () => {
    getMock.mockRejectedValue(new Error("ECONNREFUSED"));

    render(await loadPage());

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("loadError.title")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "loadError.retry" })).toHaveAttribute(
      "href",
      "/select-organization",
    );
    expect(screen.queryByTestId("org-picker")).toBeNull();
  });

  it("routes the retry through restore-session when the API answers 401", async () => {
    getMock.mockRejectedValue(
      new ApiProblem({ type: "about:blank", title: "Unauthorized", status: 401 }),
    );

    render(await loadPage());

    expect(screen.getByRole("link", { name: "loadError.retry" })).toHaveAttribute(
      "href",
      "/api/auth/restore-session?return=%2Fselect-organization",
    );
  });

  it("still redirects a successful EMPTY list to /login?error=no_tenants", async () => {
    getMock.mockResolvedValue({ data: [] });

    await expect(loadPage()).rejects.toMatchObject({ target: "/login?error=no_tenants" });
  });

  it("skips the picker for a solo-tenant user", async () => {
    getMock.mockResolvedValue({ data: [membership("org-1")] });

    await expect(loadPage()).rejects.toMatchObject({ target: "/dashboard" });
  });

  it("renders the picker for a multi-tenant user", async () => {
    getMock.mockResolvedValue({ data: [membership("org-1"), membership("org-2")] });

    render(await loadPage());

    expect(screen.getByTestId("org-picker").textContent).toBe("2");
  });
});
