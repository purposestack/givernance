import { render, screen, userEvent } from "@/tests/test-utils";

import AppError from "./error";

describe("(app)/error.tsx — in-shell error boundary (issue #614)", () => {
  it("renders the translated failure state with the digest, and retries on demand", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    const error = Object.assign(new Error("boom"), { digest: "abc123" });

    render(<AppError error={error} reset={reset} />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("This page couldn't be displayed")).toBeInTheDocument();
    expect(screen.getByText("Error ID: abc123")).toBeInTheDocument();
    // Raw error messages never reach the operator.
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
