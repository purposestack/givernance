import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TenantDetailTabs } from "./tenant-detail-tabs";

describe("TenantDetailTabs", () => {
  it("switches between overview and domains panels", async () => {
    const user = userEvent.setup();

    render(
      <TenantDetailTabs
        overview={<div>Overview content</div>}
        domains={<div>Domains content</div>}
        users={<div>Users content</div>}
        audit={<div>Audit content</div>}
      />,
    );

    expect(screen.getByText("Overview content")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Domains" }));

    expect(screen.getByText("Domains content")).toBeVisible();
  });
});
