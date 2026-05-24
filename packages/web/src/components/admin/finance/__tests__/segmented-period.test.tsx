import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { type SegmentedOption, SegmentedPeriod } from "../segmented-period";

const OPTIONS: SegmentedOption<"today" | "7d" | "30d" | "90d">[] = [
  { value: "today", label: "Aujourd'hui" },
  { value: "7d", label: "7 j" },
  { value: "30d", label: "30 j" },
  { value: "90d", label: "90 j" },
];

function Harness({ initial = "30d" as const }: { initial?: "today" | "7d" | "30d" | "90d" }) {
  const [value, setValue] = useState<typeof initial>(initial);
  return (
    <SegmentedPeriod value={value} options={OPTIONS} onChange={setValue} ariaLabel="Période" />
  );
}

describe("SegmentedPeriod", () => {
  it("renders the radiogroup with the active option aria-checked", () => {
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "Période" });
    expect(group).toBeInTheDocument();
    const active = screen.getByRole("radio", { name: "30 j" });
    expect(active).toHaveAttribute("aria-checked", "true");
    expect(active).toHaveClass("active");
  });

  it("ArrowRight wraps from last to first and selects", async () => {
    const user = userEvent.setup();
    render(<Harness initial="90d" />);
    const last = screen.getByRole("radio", { name: "90 j" });
    last.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Aujourd'hui" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("ArrowLeft moves selection backwards", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const active = screen.getByRole("radio", { name: "30 j" });
    active.focus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "7 j" })).toHaveAttribute("aria-checked", "true");
  });

  it("Home jumps to first, End to last", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole("radio", { name: "30 j" }).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "90 j" })).toHaveAttribute("aria-checked", "true");
    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Aujourd'hui" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("only the active option is in the tab order", () => {
    render(<Harness />);
    expect(screen.getByRole("radio", { name: "30 j" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "7 j" })).toHaveAttribute("tabindex", "-1");
  });
});
