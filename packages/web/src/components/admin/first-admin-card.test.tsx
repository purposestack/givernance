import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { mockApiClient, mockRouter, mockToast } from "@/tests/mocks";

import { FirstAdminCard } from "./first-admin-card";

describe("FirstAdminCard", () => {
  it("empty state — submits the invitation and surfaces the fresh token", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockResolvedValue({
      data: {
        invitationId: "inv-1",
        invitationToken: "tok-abc",
        expiresAt: "2026-05-03T00:00:00.000Z",
      },
    });

    render(<FirstAdminCard tenantId="tenant-1" invitation={null} />);

    await user.type(screen.getByLabelText(/Email/), "first@example.org");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() => {
      expect(mockApiClient.post).toHaveBeenCalledWith(
        "/v1/superadmin/tenants/tenant-1/invite-first-admin",
        { email: "first@example.org" },
      );
    });
    expect(mockToast.success).toHaveBeenCalledWith("Invitation sent to first@example.org.");
    expect(mockRouter.refresh).toHaveBeenCalled();
  });

  it("pending state — resend rotates the token, cancel deletes the invitation", async () => {
    const user = userEvent.setup();
    mockApiClient.post.mockResolvedValue({
      data: {
        invitationId: "inv-1",
        invitationToken: "tok-rotated",
        expiresAt: "2026-05-10T00:00:00.000Z",
      },
    });
    mockApiClient.delete.mockResolvedValue(undefined);

    render(
      <FirstAdminCard
        tenantId="tenant-1"
        invitation={{
          id: "inv-1",
          email: "pending@example.org",
          status: "pending",
          expiresAt: "2026-05-03T00:00:00.000Z",
          acceptedAt: null,
          createdAt: "2026-04-26T00:00:00.000Z",
        }}
      />,
    );

    expect(screen.getByText("Pending")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resend" }));
    await waitFor(() => {
      expect(mockApiClient.post).toHaveBeenCalledWith(
        "/v1/superadmin/tenants/tenant-1/invite-first-admin/inv-1/resend",
      );
    });
    expect(mockToast.success).toHaveBeenCalledWith("Invitation re-sent.");

    await user.click(screen.getByRole("button", { name: "Cancel invitation" }));
    await waitFor(() => {
      expect(mockApiClient.delete).toHaveBeenCalledWith(
        "/v1/superadmin/tenants/tenant-1/invite-first-admin/inv-1",
      );
    });
    expect(mockToast.success).toHaveBeenCalledWith("Invitation cancelled.");
  });

  it("renders the copy-link affordance only when a fresh token is available", () => {
    const invitation = {
      id: "inv-1",
      email: "pending@example.org",
      status: "pending" as const,
      expiresAt: "2026-05-03T00:00:00.000Z",
      acceptedAt: null,
      createdAt: "2026-04-26T00:00:00.000Z",
    };

    const { unmount } = render(<FirstAdminCard tenantId="tenant-1" invitation={invitation} />);
    expect(screen.queryByRole("button", { name: "Copy link" })).not.toBeInTheDocument();
    unmount();

    render(
      <FirstAdminCard tenantId="tenant-1" invitation={invitation} initialFreshToken="tok-123" />,
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
  });

  it("accepted state — collapses to a single-line confirmation with no actions", () => {
    render(
      <FirstAdminCard
        tenantId="tenant-1"
        invitation={{
          id: "inv-1",
          email: "accepted@example.org",
          status: "accepted",
          expiresAt: "2026-05-03T00:00:00.000Z",
          acceptedAt: "2026-04-27T12:00:00.000Z",
          createdAt: "2026-04-26T00:00:00.000Z",
        }}
      />,
    );

    expect(screen.queryByRole("button", { name: "Resend" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel invitation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send invitation" })).not.toBeInTheDocument();
    // Email surfaces verbatim in the accepted-state copy.
    expect(screen.getByText(/accepted@example.org/)).toBeInTheDocument();
  });

  it("surfaces 409 conflict from the API as the conflict copy", async () => {
    const user = userEvent.setup();
    const { ApiProblem } = await import("@/lib/api");
    mockApiClient.post.mockRejectedValue(
      new ApiProblem({
        type: "https://httpproblems.com/http-status/409",
        title: "Conflict",
        status: 409,
        detail: "already accepted",
      }),
    );

    render(<FirstAdminCard tenantId="tenant-1" invitation={null} />);
    await user.type(screen.getByLabelText(/Email/), "dup@example.org");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("This invitation has already been accepted.");
    });
  });
});
