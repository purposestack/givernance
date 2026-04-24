import { mockApiClient, mockRouter, mockToast } from "@/tests/mocks";
import { render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { FundsTable } from "./funds-table";

const fund = {
  id: "fund-1",
  orgId: "org-1",
  name: "Emergency Fund",
  description: "For urgent needs",
  type: "restricted" as const,
  createdAt: "2026-04-24T10:00:00.000Z",
  updatedAt: "2026-04-24T10:00:00.000Z",
};

describe("FundsTable", () => {
  it("shows edit and delete actions for managed funds", async () => {
    const user = userEvent.setup();

    render(
      <FundsTable
        funds={[fund]}
        pagination={{ page: 1, perPage: 20, total: 1, totalPages: 1 }}
        canManageFunds
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open actions for Emergency Fund" }));

    expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveAttribute(
      "href",
      "/settings/funds/fund-1/edit",
    );
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("confirms deletion, deletes the fund, and refreshes the page", async () => {
    const user = userEvent.setup();
    mockApiClient.delete.mockResolvedValue({ data: fund });

    render(
      <FundsTable
        funds={[fund]}
        pagination={{ page: 1, perPage: 20, total: 1, totalPages: 1 }}
        canManageFunds
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open actions for Emergency Fund" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(
      screen.getByText("Delete Emergency Fund? This action cannot be undone."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete fund" }));

    await waitFor(() => {
      expect(mockApiClient.delete).toHaveBeenCalledWith("/v1/funds/fund-1");
    });
    expect(mockToast.success).toHaveBeenCalledWith("Fund deleted.");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });
});
