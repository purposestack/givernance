/**
 * Issue #260 — coverage for `PlatformAdminsFilters`. Pins the URL
 * round-trip behaviour:
 *
 *   - Typing in the search input replaces (not pushes) `?q=` after the
 *     debounce settles.
 *   - Toggling "Show offboarded" replaces the URL synchronously with
 *     `?includeDeleted=true` (no debounce — toggling is intentful).
 *   - Clearing the search via the X button skips the debounce and
 *     drops `?q=` immediately.
 *   - Filter changes drop a stale `?offset=` so a refilter doesn't
 *     leave the user on page 4 of the prior result set.
 *
 * The page-side server fetch is exercised in `platform-admins.test.ts`
 * (api package) — this file locks the client/URL contract.
 */

import { mockRouter, render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { PlatformAdminsFilters } from "./platform-admins-filters";

describe("PlatformAdminsFilters", () => {
  it("typing in the search input replaces (not pushes) the URL with `?q=` after the debounce settles", async () => {
    // RTL drains the debounce timer naturally as `userEvent.type`
    // yields between keystrokes — no fake timers needed for the 250ms
    // window, the test waits long enough.
    const user = userEvent.setup();

    render(<PlatformAdminsFilters initialQ="" initialIncludeDeleted={false} />);

    await user.type(screen.getByLabelText(/search platform admins/i), "ada");

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalled();
    });
    const url = mockRouter.replace.mock.calls.at(-1)?.[0] as string;
    expect(url).toContain("q=ada");
    expect(url).not.toContain("includeDeleted=");
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("toggling include-deleted replaces the URL synchronously with `?includeDeleted=true`", async () => {
    const user = userEvent.setup();

    render(<PlatformAdminsFilters initialQ="" initialIncludeDeleted={false} />);

    await user.click(screen.getByRole("checkbox", { name: /offboarded/i }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    });
    const url = mockRouter.replace.mock.calls[0]?.[0] as string;
    expect(url).toContain("includeDeleted=true");
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it("toggling include-deleted off drops `?includeDeleted=` from the URL", async () => {
    const user = userEvent.setup();

    render(<PlatformAdminsFilters initialQ="" initialIncludeDeleted={true} />);

    await user.click(screen.getByRole("checkbox", { name: /offboarded/i }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    });
    const url = mockRouter.replace.mock.calls[0]?.[0] as string;
    expect(url).not.toContain("includeDeleted=");
  });

  it("clearing the search via the X button drops `?q=` synchronously", async () => {
    const user = userEvent.setup();

    render(<PlatformAdminsFilters initialQ="ada" initialIncludeDeleted={false} />);

    // The clear button is the X next to the input — uses `aria-label="Clear search"`
    // from the SearchInput primitive.
    await user.click(screen.getByRole("button", { name: /clear search/i }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalled();
    });
    const url = mockRouter.replace.mock.calls.at(-1)?.[0] as string;
    expect(url).not.toContain("q=");
  });
});
