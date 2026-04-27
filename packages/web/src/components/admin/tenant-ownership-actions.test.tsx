import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { mockApiClient, mockRouter, mockToast } from "@/tests/mocks";

import { TenantOwnershipActions } from "./tenant-ownership-actions";

describe("TenantOwnershipActions", () => {
  it("confirms a self-serve tenant ownership and refreshes the route", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockResolvedValue({ ownershipConfirmedAt: "2026-04-27T10:00:00.000Z" });

    render(
      <TenantOwnershipActions
        tenantId="tenant-1"
        createdVia="self_serve"
        ownershipConfirmedAt={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Confirm ownership" }));

    await waitFor(() => {
      expect(mockApiClient.post).toHaveBeenCalledWith(
        "/v1/superadmin/tenants/tenant-1/confirm-ownership",
      );
    });
    expect(mockToast.success).toHaveBeenCalledWith("Ownership confirmed.");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  it("hides the card for non self-serve tenants", () => {
    const { container } = render(
      <TenantOwnershipActions
        tenantId="tenant-2"
        createdVia="enterprise"
        ownershipConfirmedAt={null}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
