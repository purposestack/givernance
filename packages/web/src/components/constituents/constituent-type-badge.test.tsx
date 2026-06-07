import { render, screen } from "@testing-library/react";
import { ConstituentTypeBadge } from "./constituent-type-badge";

describe("ConstituentTypeBadge", () => {
  it("renders a localized label for a known lowercase type", () => {
    render(<ConstituentTypeBadge type="partner" />);
    // Resolves `constituents.types.partner` → "Partner" (en test messages).
    expect(screen.getByText("Partner")).toBeInTheDocument();
  });

  it("normalizes casing so an uppercase enum still maps to the badge", () => {
    // Regression: the campaign members table rendered the raw `PARTNER`
    // enum instead of the localized badge. Whatever the casing, it must
    // resolve to the same label as the Constituents page.
    render(<ConstituentTypeBadge type="PARTNER" />);
    expect(screen.getByText("Partner")).toBeInTheDocument();
  });

  it("falls back to the raw value for an unknown type", () => {
    render(<ConstituentTypeBadge type="future_kind" />);
    expect(screen.getByText("future_kind")).toBeInTheDocument();
  });
});
