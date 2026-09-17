import { mockApiClient, mockRouter, mockToast } from "@/tests/mocks";
import { render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { DeleteConstituentButton } from "./delete-constituent-button";

describe("DeleteConstituentButton", () => {
  it("confirms, soft-deletes the constituent and returns to the list (issue #614)", async () => {
    const user = userEvent.setup();
    mockApiClient.delete.mockResolvedValue({ data: { id: "c-1" } });

    render(<DeleteConstituentButton constituentId="c-1" constituentName="Marie Fontaine" />);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(
      screen.getByText(
        "Delete Marie Fontaine? They will be removed from lists and reports. Past donations are kept for audit.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete constituent" }));

    await waitFor(() => {
      expect(mockApiClient.delete).toHaveBeenCalledWith("/v1/constituents/c-1");
    });
    expect(mockToast.success).toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith("/constituents");
  });
});
