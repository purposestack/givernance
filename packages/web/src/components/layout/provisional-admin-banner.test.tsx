import { render, screen } from "@/tests/test-utils";

import { ProvisionalAdminBanner } from "./provisional-admin-banner";

describe("ProvisionalAdminBanner", () => {
  it("links Learn more to the members settings page, a route that exists (issue #614)", () => {
    const provisionalUntil = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    render(<ProvisionalAdminBanner info={{ provisionalUntil, orgSlug: "acme" }} />);

    expect(screen.getByRole("link", { name: "Learn more" })).toHaveAttribute(
      "href",
      "/settings/members",
    );
  });

  it("renders nothing once the provisional window has closed", () => {
    const provisionalUntil = new Date(Date.now() - 60_000).toISOString();

    const { container } = render(
      <ProvisionalAdminBanner info={{ provisionalUntil, orgSlug: "acme" }} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
