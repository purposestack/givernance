import { render, screen } from "@testing-library/react";

import { FormStickyFooter } from "./form-sticky-footer";

describe("FormStickyFooter", () => {
  it("pins its children in a sticky bottom container (issue #229)", () => {
    const { container } = render(
      <FormStickyFooter>
        <button type="submit">Save</button>
      </FormStickyFooter>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    const outer = container.firstElementChild;
    expect(outer?.className).toContain("sticky");
    expect(outer?.className).toContain("bottom-0");
    // Default inner layout: right-aligned action row (donation/constituent forms).
    expect(outer?.firstElementChild?.className).toContain("justify-end");
  });

  it("applies the inner layout override", () => {
    const { container } = render(
      <FormStickyFooter className="flex flex-col gap-4">
        <span>child</span>
      </FormStickyFooter>,
    );
    expect(container.querySelector(".flex-col")).not.toBeNull();
  });
});
