import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { mockApiClient, mockRouter, mockToast } from "@/tests/mocks";

import { TenantLifecycleActions } from "./tenant-lifecycle-actions";

describe("TenantLifecycleActions", () => {
  it("posts the selected lifecycle action, shows feedback, and refreshes the route", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockResolvedValue({ status: "suspended" });

    render(<TenantLifecycleActions tenantId="tenant-1" currentStatus="active" />);

    await user.type(screen.getByLabelText("Reason"), "Payment default");
    await user.click(screen.getByRole("button", { name: "Suspend" }));

    await waitFor(() => {
      expect(mockApiClient.post).toHaveBeenCalledWith("/v1/superadmin/tenants/tenant-1/lifecycle", {
        action: "suspend",
        reason: "Payment default",
      });
    });
    expect(mockToast.success).toHaveBeenCalledWith("Tenant lifecycle updated: suspend.");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  it("disables suspend when the tenant is already suspended", () => {
    render(<TenantLifecycleActions tenantId="tenant-2" currentStatus="suspended" />);

    expect(screen.getByRole("button", { name: "Suspend" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reactivate" })).toBeEnabled();
  });
});
