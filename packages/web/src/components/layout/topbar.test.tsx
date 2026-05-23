/**
 * Topbar tests (issue #76 / PR-1 step 2).
 *
 * Covers the account-menu dropdown behaviour the mockup spec mandates:
 *   - Avatar is a real <button> with aria-haspopup/aria-expanded managed
 *     by Radix
 *   - Clicking the avatar opens the menu
 *   - "Mon compte" link points at /profile
 *   - Active locale row has the right ARIA radio semantics
 *   - Inactive locale row triggers setLocale + router.refresh
 *   - Active locale row is a no-op (no setLocale call)
 *   - Sign out calls useAuth().logout
 *   - Pressing Escape closes the menu
 *
 * Mocks the auth, i18n, and locale-server-action layers so the test
 * exercises only the component's wiring.
 */

import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/tests/test-utils";

const mockLogout = vi.fn();
const mockSetLocale = vi.fn();
const mockRouterRefresh = vi.fn();
const mockUpdateMe = vi.fn();

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: {
      userId: "user-1",
      orgId: "org-1",
      email: "claire.dubois@solidarite-med.org",
      firstName: "Claire",
      lastName: "Dubois",
      roles: [],
    },
    logout: mockLogout,
    hasRole: () => false,
    hasAppRole: () => false,
    isImpersonating: false,
    loading: false,
    error: null,
    endImpersonation: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/i18n/locale", () => ({
  setLocale: (locale: string) => {
    mockSetLocale(locale);
    return Promise.resolve();
  },
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: () => ({}),
}));

vi.mock("@/services/UserService", () => ({
  UserService: {
    updateMe: (_client: unknown, input: { locale: string | null }) => {
      mockUpdateMe(input);
      return Promise.resolve({ locale: input.locale });
    },
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

// Import AFTER the mocks so the module picks them up.
const { Topbar } = await import("./topbar");

function renderTopbar() {
  const hamburgerRef = createRef<HTMLButtonElement>();
  return render(
    <Topbar
      onMenuToggle={vi.fn()}
      sidebarOpen={false}
      hamburgerRef={hamburgerRef as React.RefObject<HTMLButtonElement | null>}
    />,
  );
}

beforeEach(() => {
  mockLogout.mockClear();
  mockSetLocale.mockClear();
  mockRouterRefresh.mockClear();
  mockUpdateMe.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("Topbar account menu", () => {
  it("renders the avatar trigger as a button with aria-haspopup=menu", () => {
    renderTopbar();
    const trigger = screen.getByRole("button", { name: /account menu, claire dubois/i });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("opens the menu on click and toggles aria-expanded", async () => {
    const user = userEvent.setup();
    renderTopbar();
    const trigger = screen.getByRole("button", { name: /account menu/i });

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });
  });

  it("shows the user identity, Mon compte link, language radios, and destructive sign-out", async () => {
    const user = userEvent.setup();
    renderTopbar();
    await user.click(screen.getByRole("button", { name: /account menu/i }));

    expect(screen.getByText("Claire Dubois")).toBeInTheDocument();
    expect(screen.getByText("claire.dubois@solidarite-med.org")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /my account/i })).toHaveAttribute(
      "href",
      "/profile",
    );
    expect(screen.getByRole("menuitemradio", { name: /english/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: /français/i })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("menuitem", { name: /ends your session/i })).toBeInTheDocument();
  });

  it("PATCHes users.locale, sets the cookie, and refreshes the router when an inactive locale is selected", async () => {
    const user = userEvent.setup();
    renderTopbar();
    await user.click(screen.getByRole("button", { name: /account menu/i }));

    await user.click(screen.getByRole("menuitemradio", { name: /français/i }));

    // The server-side `users.locale` is the load-bearing write —
    // `resolveSessionLocale()` reads it from `/v1/users/me` and ignores
    // the NEXT_LOCALE cookie for authenticated pages.
    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ locale: "fr" });
    });
    await waitFor(() => {
      expect(mockSetLocale).toHaveBeenCalledWith("fr");
    });
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalled();
    });
  });

  it("does NOT PATCH or set cookie when the active locale row is clicked", async () => {
    const user = userEvent.setup();
    renderTopbar();
    await user.click(screen.getByRole("button", { name: /account menu/i }));

    await user.click(screen.getByRole("menuitemradio", { name: /english/i }));

    expect(mockUpdateMe).not.toHaveBeenCalled();
    expect(mockSetLocale).not.toHaveBeenCalled();
  });

  it("does not write the cookie or refresh when the PATCH fails (transient API error)", async () => {
    mockUpdateMe.mockImplementationOnce(() => {
      throw new Error("api down");
    });
    const user = userEvent.setup();
    renderTopbar();
    await user.click(screen.getByRole("button", { name: /account menu/i }));

    await user.click(screen.getByRole("menuitemradio", { name: /français/i }));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalled();
    });
    expect(mockSetLocale).not.toHaveBeenCalled();
    expect(mockRouterRefresh).not.toHaveBeenCalled();
  });

  it("invokes useAuth().logout when the sign-out item is activated", async () => {
    const user = userEvent.setup();
    renderTopbar();
    await user.click(screen.getByRole("button", { name: /account menu/i }));

    await user.click(screen.getByRole("menuitem", { name: /ends your session/i }));

    expect(mockLogout).toHaveBeenCalledOnce();
  });

  it("closes the menu when Escape is pressed", async () => {
    const user = userEvent.setup();
    renderTopbar();
    const trigger = screen.getByRole("button", { name: /account menu/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });
  });
});

// ─── Command palette trigger (Epic #364, GLO-001) ────────────────────────

function renderTopbarWithPalette(
  opts: { enabled: boolean; onOpen?: () => void } = {
    enabled: false,
  },
) {
  const hamburgerRef = createRef<HTMLButtonElement>();
  return render(
    <Topbar
      onMenuToggle={vi.fn()}
      sidebarOpen={false}
      hamburgerRef={hamburgerRef as React.RefObject<HTMLButtonElement | null>}
      commandPaletteEnabled={opts.enabled}
      onCommandPaletteOpen={opts.onOpen}
    />,
  );
}

describe("Topbar command-palette trigger", () => {
  it("is completely absent when the flag is off (off-state QA)", () => {
    renderTopbarWithPalette({ enabled: false });
    // Neither the explicit aria-label nor any button matching the
    // placeholder should appear. We use a regex on the EN aria-label
    // ("Open quick search") and assert null.
    expect(screen.queryByRole("button", { name: /open quick search/i })).toBeNull();
  });

  it("renders a button with aria-haspopup=dialog when the flag is on", () => {
    renderTopbarWithPalette({ enabled: true, onOpen: vi.fn() });
    const trigger = screen.getByRole("button", { name: /open quick search/i });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("invokes onCommandPaletteOpen when clicked", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderTopbarWithPalette({ enabled: true, onOpen });
    const trigger = screen.getByRole("button", { name: /open quick search/i });
    await user.click(trigger);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
