import { ApiProblem } from "@/lib/api";
import { PlatformAdminService } from "@/services/PlatformAdminService";
import { mockRouter, mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { NewPlatformAdminForm } from "./new-platform-admin-form";

vi.mock("@/services/PlatformAdminService", () => ({
  PlatformAdminService: {
    create: vi.fn(),
  },
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: () => ({}),
}));

describe("NewPlatformAdminForm", () => {
  it("submits the create payload and toasts success", async () => {
    const user = userEvent.setup();
    // Post fix-commit-4 refactor: create returns an invitation summary,
    // not a `PlatformAdmin` row (the row materialises at accept time).
    vi.mocked(PlatformAdminService.create).mockResolvedValue({
      invitationId: "00000000-0000-0000-0000-0000000aaaaa",
      email: "ada@example.org",
      firstName: "Ada",
      lastName: "Lovelace",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    render(<NewPlatformAdminForm />);

    await user.type(screen.getByLabelText(/First name/i), "Ada");
    await user.type(screen.getByLabelText(/Last name/i), "Lovelace");
    await user.type(screen.getByLabelText(/Email/i), "ada@example.org");
    await user.click(screen.getByRole("button", { name: /Send invitation/i }));

    await waitFor(() => {
      expect(PlatformAdminService.create).toHaveBeenCalledWith(expect.anything(), {
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.org",
      });
    });
    expect(mockToast.success).toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalledWith("/admin/platform-admins");
  });

  it("maps a 409 with 'tenant member' detail to the email-collision field error (no toast)", async () => {
    const user = userEvent.setup();
    vi.mocked(PlatformAdminService.create).mockRejectedValue(
      new ApiProblem({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "This email belongs to a tenant member; …",
      }),
    );

    render(<NewPlatformAdminForm />);

    await user.type(screen.getByLabelText(/First name/i), "Ada");
    await user.type(screen.getByLabelText(/Last name/i), "Lovelace");
    await user.type(screen.getByLabelText(/Email/i), "ada@example.org");
    await user.click(screen.getByRole("button", { name: /Send invitation/i }));

    expect(await screen.findByText(/email belongs to a tenant member/i)).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("maps a 502 to the keycloak-misconfig toast", async () => {
    const user = userEvent.setup();
    vi.mocked(PlatformAdminService.create).mockRejectedValue(
      new ApiProblem({
        type: "about:blank",
        title: "Bad Gateway",
        status: 502,
        detail: "Keycloak realm role 'super_admin' is missing",
      }),
    );

    render(<NewPlatformAdminForm />);

    await user.type(screen.getByLabelText(/First name/i), "Ada");
    await user.type(screen.getByLabelText(/Last name/i), "Lovelace");
    await user.type(screen.getByLabelText(/Email/i), "ada@example.org");
    await user.click(screen.getByRole("button", { name: /Send invitation/i }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalled();
    });
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
