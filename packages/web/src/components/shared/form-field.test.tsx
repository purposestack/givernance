import { useForm } from "react-hook-form";

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/shared/form-field";
import { render, screen, userEvent } from "../../tests/test-utils";

interface SignupFormValues {
  email: string;
}

/**
 * Minimal harness that mirrors the production `FormField` wiring — controlled
 * input, onBlur validation, and a `<FormMessage>` next to the control. The
 * tests below assert the primitive's a11y contract for issue #155 (validation
 * errors must announce immediately so AT users don't have to re-focus the
 * field to hear why it stayed invalid).
 */
function HarnessForm() {
  const form = useForm<SignupFormValues>({
    mode: "onBlur",
    defaultValues: { email: "" },
  });

  return (
    <Form {...form}>
      <form>
        <FormField
          control={form.control}
          name="email"
          rules={{ required: "Email is required" }}
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <input type="email" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}

describe("FormMessage — a11y (issue #155)", () => {
  it("announces validation errors via role=alert + aria-live=assertive", async () => {
    const user = userEvent.setup();
    render(<HarnessForm />);

    const input = screen.getByLabelText("Email");
    await user.click(input);
    await user.tab(); // onBlur triggers validation → error renders

    // role=alert is what fires the live-region announcement on AT.
    // Without it, the error stays silent until the user re-focuses
    // the field — the exact bug #155 captures.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Email is required");
    // Belt-and-suspenders for the legacy screen readers that honour
    // aria-live without recognising the implicit role mapping.
    expect(alert).toHaveAttribute("aria-live", "assertive");
  });

  it("does not render an alert region when there is no error", () => {
    render(<HarnessForm />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
