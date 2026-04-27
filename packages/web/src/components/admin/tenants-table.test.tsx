import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { mockRouter } from "@/tests/mocks";

import { TenantsTable } from "./tenants-table";

describe("TenantsTable", () => {
  it("pushes sort params when a sortable header is clicked", async () => {
    const user = userEvent.setup();

    render(
      <TenantsTable
        tenants={[
          {
            id: "tenant-1",
            name: "Acme Foundation",
            slug: "acme-foundation",
            plan: "enterprise",
            status: "active",
            createdVia: "enterprise",
            verifiedAt: null,
            ownershipConfirmedAt: null,
            primaryDomain: "acme.org",
            keycloakOrgId: "kc-acme",
            defaultLocale: "fr",
            createdAt: "2026-04-10T10:00:00.000Z",
            updatedAt: "2026-04-21T10:00:00.000Z",
          },
        ]}
        sort="createdAt"
        order="desc"
      />,
    );

    await user.click(screen.getByRole("button", { name: /tenant/i }));

    expect(mockRouter.push).toHaveBeenCalledWith("/settings/funds?sort=name&order=asc");
  });

  it("renders tenant rows and navigates to the detail page on row click", async () => {
    const user = userEvent.setup();

    render(
      <TenantsTable
        tenants={[
          {
            id: "tenant-1",
            name: "Acme Foundation",
            slug: "acme-foundation",
            plan: "enterprise",
            status: "active",
            createdVia: "sales-led",
            verifiedAt: "2026-04-20T10:00:00.000Z",
            ownershipConfirmedAt: null,
            primaryDomain: "acme.org",
            keycloakOrgId: "kc-acme",
            defaultLocale: "fr",
            createdAt: "2026-04-10T10:00:00.000Z",
            updatedAt: "2026-04-21T10:00:00.000Z",
          },
        ]}
        sort="createdAt"
        order="desc"
      />,
    );

    expect(screen.getByText("Acme Foundation")).toBeInTheDocument();
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(screen.getAllByText(/10 Apr 2026/).length).toBeGreaterThan(0);

    await user.click(screen.getByText("Acme Foundation"));

    expect(mockRouter.push).toHaveBeenCalledWith("/admin/tenants/tenant-1");
  });
});
