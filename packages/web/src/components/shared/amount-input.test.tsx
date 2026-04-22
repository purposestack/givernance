import { useState } from "react";

import { AmountInput } from "@/components/shared/amount-input";
import { render, screen, userEvent } from "../../tests/test-utils";

describe("AmountInput", () => {
  function ControlledAmountInput() {
    const [value, setValue] = useState<number | null>(null);

    return (
      <div>
        <AmountInput
          value={value}
          onChange={(nextValue, meta) => {
            if (meta.isValid) {
              setValue(nextValue);
            }
          }}
          placeholder="0.00"
        />
        <button type="button" onClick={() => setValue(4500)}>
          sync
        </button>
      </div>
    );
  }

  it("parses decimal values and normalizes them on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<AmountInput value={null} onChange={onChange} placeholder="0.00" />);

    const input = screen.getByPlaceholderText("0.00");

    await user.type(input, "12,34");

    expect(onChange).toHaveBeenLastCalledWith(1234, {
      raw: "12,34",
      isValid: true,
      isEmpty: false,
    });

    await user.tab();

    expect(input).toHaveValue("12.34");
  });

  it("preserves invalid raw values and reports invalid metadata", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(<AmountInput value={null} onChange={onChange} placeholder="0.00" />);

    const input = screen.getByPlaceholderText("0.00");
    await user.type(input, "12.345");

    expect(onChange).toHaveBeenLastCalledWith(null, {
      raw: "12.345",
      isValid: false,
      isEmpty: true,
    });

    await user.tab();

    expect(input).toHaveValue("12.345");
  });

  it("syncs external controlled value updates without clobbering typing", async () => {
    const user = userEvent.setup();

    render(<ControlledAmountInput />);

    await user.click(screen.getByRole("button", { name: "sync" }));

    expect(screen.getByPlaceholderText("0.00")).toHaveValue("45.00");
  });
});
