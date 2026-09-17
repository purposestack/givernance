import { ApiProblem } from "@/lib/api/problem";
import type { Member } from "@/models/member";
import { mockApiClient, mockToast } from "@/tests/mocks";
import { render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { MembersTable } from "./members-table";

const self: Member = {
  id: "user-self",
  orgId: "org-1",
  keycloakId: "kc-self",
  email: "self@example.org",
  firstName: "Sam",
  lastName: "Self",
  role: "org_admin",
  createdAt: "2026-04-24T10:00:00.000Z",
  updatedAt: "2026-04-24T10:00:00.000Z",
};

const other: Member = {
  ...self,
  id: "user-other",
  keycloakId: "kc-other",
  email: "other@example.org",
  firstName: "Olive",
  lastName: "Other",
};

const pagination = { page: 1, perPage: 20, total: 2, totalPages: 1 };

describe("MembersTable", () => {
  it("hides Remove on the caller's own row but keeps it on other rows (issue #614)", async () => {
    const user = userEvent.setup();

    render(
      <MembersTable
        members={[self, other]}
        pagination={pagination}
        canManageMembers
        currentUserKeycloakId="kc-self"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open actions for self@example.org" }));
    expect(screen.getByRole("menuitem", { name: "Edit member" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove member" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Open actions for other@example.org" }));
    expect(screen.getByRole("menuitem", { name: "Remove member" })).toBeInTheDocument();
  });

  it("maps the cannot_remove_last_admin 422 to a translated toast", async () => {
    const user = userEvent.setup();
    mockApiClient.delete.mockRejectedValue(
      new ApiProblem({
        type: "https://httpproblems.com/http-status/422",
        title: "Unprocessable Entity",
        status: 422,
        detail: "Cannot remove the last org_admin in this tenant — promote another admin first.",
        errorCode: "cannot_remove_last_admin",
      }),
    );

    render(
      <MembersTable
        members={[self, other]}
        pagination={pagination}
        canManageMembers
        currentUserKeycloakId="kc-self"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open actions for other@example.org" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove member" }));
    await user.click(screen.getByRole("button", { name: "Remove member" }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith(
        "Can't remove the last admin in this workspace — promote another admin first.",
      );
    });
  });
});
