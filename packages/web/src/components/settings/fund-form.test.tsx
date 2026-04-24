import { mockApiClient, mockRouter, mockToast } from "@/tests/mocks";
import { render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { FundForm } from "./fund-form";

describe("FundForm", () => {
  it("creates a fund and returns to the funds list", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockResolvedValue({
      data: {
        id: "fund-1",
        orgId: "org-1",
        name: "Emergency Fund",
        description: null,
        type: "restricted",
        createdAt: "2026-04-24T10:00:00.000Z",
        updatedAt: "2026-04-24T10:00:00.000Z",
      },
    });

    render(<FundForm mode="create" canManageFunds />);

    await user.type(screen.getByRole("textbox", { name: /Fund name/ }), "Emergency Fund");
    await user.click(screen.getByRole("button", { name: "Create fund" }));

    await waitFor(() => {
      expect(mockApiClient.post).toHaveBeenCalledWith("/v1/funds", {
        name: "Emergency Fund",
        description: null,
        type: "unrestricted",
      });
    });
    expect(mockToast.success).toHaveBeenCalledWith("Fund created.");
    expect(mockRouter.push).toHaveBeenCalledWith("/settings/funds");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  it("updates an existing fund and shows the edit success state", async () => {
    const user = userEvent.setup();
    mockApiClient.patch.mockResolvedValue({
      data: {
        id: "fund-2",
        orgId: "org-1",
        name: "Updated Fund",
        description: "Clarified use",
        type: "restricted",
        createdAt: "2026-04-24T10:00:00.000Z",
        updatedAt: "2026-04-24T11:00:00.000Z",
      },
    });

    render(
      <FundForm
        mode="edit"
        canManageFunds
        fund={{
          id: "fund-2",
          orgId: "org-1",
          name: "Legacy Fund",
          description: "Old description",
          type: "restricted",
          createdAt: "2026-04-24T10:00:00.000Z",
          updatedAt: "2026-04-24T10:00:00.000Z",
        }}
      />,
    );

    await user.clear(screen.getByRole("textbox", { name: /Fund name/ }));
    await user.type(screen.getByRole("textbox", { name: /Fund name/ }), "Updated Fund");
    await user.clear(screen.getByRole("textbox", { name: "Description" }));
    await user.type(screen.getByRole("textbox", { name: "Description" }), "Clarified use");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(mockApiClient.patch).toHaveBeenCalledWith("/v1/funds/fund-2", {
        name: "Updated Fund",
        description: "Clarified use",
        type: "restricted",
      });
    });
    expect(mockToast.success).toHaveBeenCalledWith("Fund updated.");
    expect(mockRouter.push).toHaveBeenCalledWith("/settings/funds");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });
});
