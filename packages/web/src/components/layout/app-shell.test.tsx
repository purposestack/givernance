/**
 * AppShell tests — focused on the global Cmd+K listener wiring added by
 * Epic #364 (GLO-001). The shell composes Sidebar / Topbar / Banners /
 * CommandPalette; this suite only asserts behaviours the shell itself
 * owns (the keydown listener + off-state mounting). The downstream
 * components have their own tests.
 *
 * Mocks every collaborator that fetches or routes so the test exercises
 * just the AppShell wiring.
 */

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/test-utils";

function fireKeydown(opts: KeyboardEventInit) {
  // `act` flushes the React state update triggered by the global
  // `keydown` listener AppShell attached to `document`. Without `act`
  // the assertion races the render and the palette sentinel hasn't
  // landed in the DOM yet.
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { ...opts, bubbles: true }));
  });
}

// ─── Mocks ───────────────────────────────────────────────────────────

const mockCommandPalette = vi.fn();

vi.mock("@/components/command-palette/command-palette", () => ({
  CommandPalette: (props: { open: boolean; onClose: () => void }) => {
    mockCommandPalette(props);
    // Render a sentinel only when open so the test can assert presence
    // via DOM query rather than spying on props.
    return props.open ? <div data-testid="cmdk-palette">palette</div> : null;
  },
}));

vi.mock("@/components/branding/add-logo-banner", () => ({
  AddLogoBanner: () => null,
}));

vi.mock("./impersonation-banner", () => ({
  ImpersonationBanner: () => null,
}));

vi.mock("./provisional-admin-banner", () => ({
  ProvisionalAdminBanner: () => null,
}));

vi.mock("./sidebar", () => ({
  Sidebar: () => <aside data-testid="sidebar" />,
}));

vi.mock("./topbar", () => ({
  Topbar: () => <header data-testid="topbar" />,
}));

// Import AFTER the mocks so the module picks them up.
const { AppShell } = await import("./app-shell");

beforeEach(() => {
  mockCommandPalette.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderShell(props: { commandPaletteEnabled: boolean }) {
  return render(
    <AppShell
      impersonation={undefined}
      impersonationUserName={undefined}
      commandPaletteEnabled={props.commandPaletteEnabled}
    >
      <main data-testid="children">child</main>
    </AppShell>,
  );
}

describe("AppShell — command palette off-state", () => {
  it("does not render the CommandPalette component when the flag is off", () => {
    renderShell({ commandPaletteEnabled: false });
    expect(screen.queryByTestId("cmdk-palette")).toBeNull();
    expect(mockCommandPalette).not.toHaveBeenCalled();
  });

  it("Cmd+K is a no-op when the flag is off (listener not mounted)", () => {
    renderShell({ commandPaletteEnabled: false });
    fireKeydown({ key: "k", metaKey: true });
    expect(screen.queryByTestId("cmdk-palette")).toBeNull();
    expect(mockCommandPalette).not.toHaveBeenCalled();
  });
});

describe("AppShell — command palette on-state", () => {
  it("renders the CommandPalette component (closed) when the flag is on", () => {
    renderShell({ commandPaletteEnabled: true });
    // Mount = the mock was called once with open=false; the sentinel
    // is absent because open=false.
    expect(mockCommandPalette).toHaveBeenCalledWith(expect.objectContaining({ open: false }));
    expect(screen.queryByTestId("cmdk-palette")).toBeNull();
  });

  it("opens the palette when Meta+K is pressed", () => {
    renderShell({ commandPaletteEnabled: true });
    fireKeydown({ key: "k", metaKey: true });
    expect(screen.getByTestId("cmdk-palette")).toBeDefined();
  });

  it("opens the palette when Ctrl+K is pressed (non-Mac)", () => {
    renderShell({ commandPaletteEnabled: true });
    fireKeydown({ key: "k", ctrlKey: true });
    expect(screen.getByTestId("cmdk-palette")).toBeDefined();
  });

  it("does NOT open on Meta+Shift+K (devtools chord)", () => {
    renderShell({ commandPaletteEnabled: true });
    fireKeydown({ key: "k", metaKey: true, shiftKey: true });
    expect(screen.queryByTestId("cmdk-palette")).toBeNull();
  });

  it("does NOT open on Alt+K alone", () => {
    renderShell({ commandPaletteEnabled: true });
    fireKeydown({ key: "k", altKey: true });
    expect(screen.queryByTestId("cmdk-palette")).toBeNull();
  });

  it("toggles closed when Meta+K is pressed a second time", () => {
    renderShell({ commandPaletteEnabled: true });
    fireKeydown({ key: "k", metaKey: true });
    expect(screen.getByTestId("cmdk-palette")).toBeDefined();
    fireKeydown({ key: "k", metaKey: true });
    expect(screen.queryByTestId("cmdk-palette")).toBeNull();
  });
});
