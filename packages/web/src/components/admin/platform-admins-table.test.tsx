/**
 * Issue #255 (QA review m3) — direct vitest coverage for
 * `PlatformAdminsTable.onSortingChange`. Click-to-sort updates URL
 * params via `router.replace` (NOT `push`) so the back button escapes
 * the page in one press rather than unwinding every header click —
 * same posture as `TenantsTable` (issue #217). The PR #253 review
 * called out that this had no regression test.
 */

import type { PlatformAdmin } from "@/models/platform-admin";
import { mockRouter, render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { PlatformAdminsTable } from "./platform-admins-table";

function makeAdmin(overrides: Partial<PlatformAdmin> = {}): PlatformAdmin {
  return {
    id: "00000000-0000-0000-0000-00000000aaaa",
    keycloakId: "kc-1",
    email: "ada@example.org",
    firstName: "Ada",
    lastName: "Lovelace",
    lastLoginAt: null,
    deletedAt: null,
    createdAt: "2026-04-10T10:00:00.000Z",
    updatedAt: "2026-04-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("PlatformAdminsTable.onSortingChange", () => {
  it("clicking a sortable header replaces (NOT pushes) the URL with the new sort params", async () => {
    const user = userEvent.setup();

    render(
      <PlatformAdminsTable
        admins={[makeAdmin()]}
        total={1}
        // Default sort is `createdAt desc`. Clicking the `email` header
        // toggles to `email asc`. The pathname is hardcoded to
        // `/settings/funds` by the global test setup
        // (`packages/web/src/tests/setup.tsx`); the assertion uses that
        // value rather than the production `/admin/platform-admins`
        // because what we're locking is the params/strategy, not the path.
        sort="createdAt"
        order="desc"
      />,
    );

    // The DataTable renders sortable headers as buttons. Find the
    // `email` column header by its rendered string (i18n maps the
    // `columns.email` key to "Email" in both fr/en bundles for this
    // listing).
    await user.click(screen.getByRole("button", { name: /email/i }));

    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledTimes(1);
    });
    const url = mockRouter.replace.mock.calls[0]?.[0] as string;
    expect(url).toContain("sort=email");
    expect(url).toContain("order=asc");
    // Crucially `push` is NOT called — that would pollute the back
    // stack with one entry per sort click.
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
});
