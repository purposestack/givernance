import { ApiProblem } from "@/lib/api";
import { createEnterpriseTenant, inviteFirstAdmin } from "@/services/TenantAdminService";
import { mockRouter, mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { NewTenantForm } from "./new-tenant-form";

vi.mock("@/services/TenantAdminService", () => ({
  createEnterpriseTenant: vi.fn(),
  inviteFirstAdmin: vi.fn(),
}));

describe("NewTenantForm", () => {
  it("sends the optional first-admin names with the invitation", async () => {
    const user = userEvent.setup();
    vi.mocked(createEnterpriseTenant).mockResolvedValue({
      tenantId: "tenant-123",
      slug: "croix-rouge",
      keycloakOrgId: "org-123",
      status: "provisional",
    });
    vi.mocked(inviteFirstAdmin).mockResolvedValue({
      invitationId: "invite-123",
      invitationToken: "token-123",
      expiresAt: "2026-04-27T12:00:00.000Z",
    });

    render(<NewTenantForm />);

    await user.type(screen.getByLabelText(/Organisation name/i), "Croix Rouge");
    await user.type(screen.getByLabelText(/First admin first name/i), "Ada");
    await user.type(screen.getByLabelText(/First admin last name/i), "Lovelace");
    await user.type(screen.getByLabelText(/First admin email/i), "ada@example.org");
    await user.click(screen.getByRole("button", { name: /Create enterprise tenant/i }));

    await waitFor(() => {
      expect(inviteFirstAdmin).toHaveBeenCalledWith(
        "tenant-123",
        "ada@example.org",
        null,
        "Ada",
        "Lovelace",
      );
    });
  });

  it("shows the duplicate slug error inline without a second toast", async () => {
    const user = userEvent.setup();
    vi.mocked(createEnterpriseTenant).mockRejectedValue(
      new ApiProblem({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "This tenant URL is already taken.",
      }),
    );

    render(<NewTenantForm />);

    await user.type(screen.getByLabelText(/Organisation name/i), "Croix Rouge");
    await user.clear(screen.getByLabelText(/Workspace URL/i));
    await user.type(screen.getByLabelText(/Workspace URL/i), "croix-rouge");
    await user.click(screen.getByRole("button", { name: /Create enterprise tenant/i }));

    expect(await screen.findByText("This slug is already taken.")).toBeInTheDocument();
    expect(mockToast.error).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
