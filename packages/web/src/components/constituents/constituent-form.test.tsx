import { ConstituentForm } from "@/components/constituents/constituent-form";
import { render, screen, userEvent } from "@/tests/test-utils";

/**
 * Regression guard for issue #465. The multi-type chip group renders each type
 * as a toggle `<button>`; the checkbox visual inside it MUST NOT be a real
 * (Radix) `<button>` — nesting `<button>` in `<button>` is an HTML invariant
 * violation that crashes the page with a hydration error AND a Radix
 * focus-scope "Maximum update depth exceeded" loop. jsdom won't reject the bad
 * nesting, so we assert the structure explicitly: no chip contains a nested
 * interactive element, and toggling works (a real loop would throw on render).
 */
describe("ConstituentForm — multi-type chip group (issue #465)", () => {
  function typeChips(): HTMLElement[] {
    return screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-pressed"));
  }

  it("renders one toggle chip per type with NO nested <button>", () => {
    render(<ConstituentForm mode="create" multiTypeEnabled />);

    const chips = typeChips();
    // Five canonical types → five chips.
    expect(chips).toHaveLength(5);

    for (const chip of chips) {
      // The decorative checkbox must be a <span>, not a nested control.
      expect(chip.querySelector("button")).toBeNull();
      expect(chip.querySelector('[role="checkbox"]')).toBeNull();
    }
  });

  it("toggles a chip without crashing (no focus-scope update loop)", async () => {
    const user = userEvent.setup();
    render(<ConstituentForm mode="create" multiTypeEnabled />);

    // `donor` is the create default → exactly one chip starts pressed.
    const chips = typeChips();
    expect(chips.filter((c) => c.getAttribute("aria-pressed") === "true")).toHaveLength(1);

    const unpressed = chips.find((c) => c.getAttribute("aria-pressed") === "false");
    if (!unpressed) throw new Error("expected at least one unpressed chip");
    await user.click(unpressed);

    expect(unpressed.getAttribute("aria-pressed")).toBe("true");
  });

  it("hides the chip group when the flag is off (single Select only)", () => {
    render(<ConstituentForm mode="create" multiTypeEnabled={false} />);
    // Off-state: no toggle chips at all — the surface is completely absent.
    expect(typeChips()).toHaveLength(0);
  });
});
