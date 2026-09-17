import { render, screen } from "@/tests/test-utils";

import { DonationStatusBadge } from "./donation-status-badge";

describe("DonationStatusBadge", () => {
  it.each([
    ["cleared", "Cleared"],
    ["pending", "Pending"],
    ["refunded", "Refunded"],
    ["failed", "Failed"],
  ] as const)("renders the translated label for %s with a decorative icon", (status, label) => {
    const { container } = render(<DonationStatusBadge status={status} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    // Colour is never the sole signal — each status pairs an icon with text.
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});
