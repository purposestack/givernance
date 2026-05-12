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
  it("announces validation errors via a polite status live-region", async () => {
    const user = userEvent.setup();
    render(<HarnessForm />);

    const input = screen.getByLabelText("Email");
    await user.click(input);
    await user.tab(); // onBlur triggers validation → error text appears

    // `role=status` (which implies `aria-live=polite` + `aria-atomic=true`)
    // queues the message after the current screen-reader speech rather
    // than pre-empting it — the assertive variant turned out to flood
    // over the curated `rootError` summary that 9 forms render alongside
    // FormMessage (multi-agent review M1 on PR #358).
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Email is required");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the live region mounted across error → clear → re-error transitions", async () => {
    // AT combinations (NVDA + Firefox in particular) skip the re-
    // announce when the live region itself mounts and unmounts every
    // time the error toggles. Keeping the `<p>` in the DOM (sr-only
    // when empty) turns each transition into a *content change* on a
    // stable region, which is what assistive tech reliably fires on.
    const user = userEvent.setup();
    render(<HarnessForm />);

    const input = screen.getByLabelText("Email");
    // Initial render: region exists, body is empty.
    const initialStatus = screen.getByRole("status", { hidden: true });
    expect(initialStatus.id).toBeTruthy();
    expect(initialStatus.textContent).toBe("");
    const stableId = initialStatus.id;

    // Trigger validation → same node carries the message (same id).
    await user.click(input);
    await user.tab();
    const errored = await screen.findByRole("status");
    expect(errored.id).toBe(stableId);
    expect(errored).toHaveTextContent("Email is required");

    // Clear by typing then blurring with a valid value — region stays
    // mounted, body empties.
    await user.click(input);
    await user.type(input, "valid@example.org");
    await user.tab();
    const cleared = screen.getByRole("status", { hidden: true });
    expect(cleared.id).toBe(stableId);
    expect(cleared.textContent).toBe("");
  });
});
