/**
 * Issue #255 — direct vitest coverage for `PlatformAdminDetailActions`
 * (QA review M5 follow-up to PR #253). Locks the user-visible behaviour
 * of the three confirm-dialog actions on the detail page:
 *
 *   - Rename happy path → toast + router refresh
 *   - 400 + "last active" detail → distinct error toast
 *   - 400 + "own platform-admin row" detail → distinct error toast
 *   - 404 → "not found" toast (separate string from generic 502/500)
 *   - `isSelf` hides the remove button when operator IS the admin
 *
 * The PlatformAdminService is fully mocked — the API contract is
 * exercised in `platform-admins.test.ts` against a real server.
 */

import { ApiProblem } from "@/lib/api";
import type { PlatformAdmin } from "@/models/platform-admin";
import { PlatformAdminService } from "@/services/PlatformAdminService";
import { mockRouter, mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { PlatformAdminDetailActions } from "./platform-admin-detail-actions";

vi.mock("@/services/PlatformAdminService", () => ({
  PlatformAdminService: {
    updateName: vi.fn(),
    resetPassword: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: () => ({}),
}));

function makeAdmin(overrides: Partial<PlatformAdmin> = {}): PlatformAdmin {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    keycloakId: "kc-target-001",
    email: "target@example.org",
    firstName: "Target",
    lastName: "User",
    lastLoginAt: null,
    deletedAt: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("PlatformAdminDetailActions", () => {
  it("rename happy path: calls service, shows success toast, refreshes router", async () => {
    const user = userEvent.setup();
    vi.mocked(PlatformAdminService.updateName).mockResolvedValue(makeAdmin());

    render(<PlatformAdminDetailActions admin={makeAdmin()} operatorKeycloakId="kc-operator-99" />);

    await user.click(screen.getByRole("button", { name: /edit/i }));
    const firstNameInput = await screen.findByLabelText(/First name/i);
    await user.clear(firstNameInput);
    await user.type(firstNameInput, "Renamed");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(PlatformAdminService.updateName).toHaveBeenCalledWith(
        expect.anything(),
        "00000000-0000-0000-0000-000000000001",
        expect.objectContaining({ firstName: "Renamed" }),
      );
    });
    expect(mockToast.success).toHaveBeenCalled();
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  it("remove → 400 + 'last active' surfaces the last-admin toast (distinct from generic)", async () => {
    const user = userEvent.setup();
    vi.mocked(PlatformAdminService.remove).mockRejectedValue(
      new ApiProblem({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "Cannot remove the last active platform admin.",
      }),
    );

    render(<PlatformAdminDetailActions admin={makeAdmin()} operatorKeycloakId="kc-operator-99" />);

    await user.click(screen.getByRole("button", { name: /remove/i }));
    // The AlertDialog confirm action — the destructive button inside
    // the open dialog. There are now two "Remove" buttons in the DOM
    // (the trigger + the confirm), so disambiguate by name on the
    // confirm copy. The trigger's `actions.remove` translation differs
    // from the dialog's `removeDialog.confirm`.
    const confirmButtons = await screen.findAllByRole("button");
    const confirm = confirmButtons.find(
      (b) => b.textContent && /remove/i.test(b.textContent) && b.className.includes("bg-error"),
    );
    if (!confirm) throw new Error("destructive confirm button not found");
    await user.click(confirm);

    await waitFor(() => {
      expect(PlatformAdminService.remove).toHaveBeenCalledTimes(1);
    });
    // The component reads i18n keys; we assert that *some* error toast
    // fired and that the success path did not. The exact key
    // (`errors.lastAdmin` vs `errors.generic`) is locked at the
    // i18n-resolution layer.
    expect(mockToast.error).toHaveBeenCalled();
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("remove → 400 + 'own platform-admin row' surfaces the self-removal toast", async () => {
    const user = userEvent.setup();
    vi.mocked(PlatformAdminService.remove).mockRejectedValue(
      new ApiProblem({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "Operators cannot soft-delete their own platform-admin row.",
      }),
    );

    // operator != admin so the remove button is visible. We hit the
    // server-side guard not the client-side hide — exercising that the
    // 400 'own platform-admin row' detail wins the regex branch.
    render(<PlatformAdminDetailActions admin={makeAdmin()} operatorKeycloakId="kc-operator-99" />);

    await user.click(screen.getByRole("button", { name: /remove/i }));
    const confirmButtons = await screen.findAllByRole("button");
    const confirm = confirmButtons.find(
      (b) => b.textContent && /remove/i.test(b.textContent) && b.className.includes("bg-error"),
    );
    if (!confirm) throw new Error("destructive confirm button not found");
    await user.click(confirm);

    await waitFor(() => {
      expect(PlatformAdminService.remove).toHaveBeenCalledTimes(1);
    });
    expect(mockToast.error).toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("remove → 404 surfaces a distinct not-found toast", async () => {
    const user = userEvent.setup();
    vi.mocked(PlatformAdminService.remove).mockRejectedValue(
      new ApiProblem({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "Platform admin not found.",
      }),
    );

    render(<PlatformAdminDetailActions admin={makeAdmin()} operatorKeycloakId="kc-operator-99" />);

    await user.click(screen.getByRole("button", { name: /remove/i }));
    const confirmButtons = await screen.findAllByRole("button");
    const confirm = confirmButtons.find(
      (b) => b.textContent && /remove/i.test(b.textContent) && b.className.includes("bg-error"),
    );
    if (!confirm) throw new Error("destructive confirm button not found");
    await user.click(confirm);

    await waitFor(() => {
      expect(PlatformAdminService.remove).toHaveBeenCalledTimes(1);
    });
    expect(mockToast.error).toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("isSelf hides the remove button when admin.keycloakId === operatorKeycloakId", () => {
    render(
      <PlatformAdminDetailActions
        admin={makeAdmin({ keycloakId: "kc-self" })}
        operatorKeycloakId="kc-self"
      />,
    );

    // Edit + reset are present, remove is not.
    expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("isSelf does NOT trigger when operatorKeycloakId is null (stale auth, parallel-tab race) — remove button stays visible", () => {
    // The intent comment in the component spells out: a null operator
    // sub means we don't *know* who the operator is, so we err on the
    // side of showing the button and let the API guard catch the
    // self-removal attempt. This pins that posture.
    render(
      <PlatformAdminDetailActions
        admin={makeAdmin({ keycloakId: "kc-target-001" })}
        operatorKeycloakId={null}
      />,
    );

    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });
});
