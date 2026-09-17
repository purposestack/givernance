import { describe, expect, it } from "vitest";

import { lastPageHref } from "./pagination";

describe("lastPageHref", () => {
  it("returns null when the requested page exists", () => {
    expect(lastPageHref("/donations", {}, { page: 2, total: 45, totalPages: 3 })).toBeNull();
    expect(lastPageHref("/donations", {}, { page: 3, total: 45, totalPages: 3 })).toBeNull();
  });

  it("returns null for a genuinely empty list (the empty state is the answer)", () => {
    expect(lastPageHref("/donations", {}, { page: 4, total: 0, totalPages: 0 })).toBeNull();
  });

  it("points at the last page and preserves the other params, arrays included", () => {
    const href = lastPageHref(
      "/constituents",
      { page: "9", perPage: "20", search: "du pont", types: ["donor", "member"], empty: undefined },
      { page: 9, total: 45, totalPages: 3 },
    );
    expect(href).toBe("/constituents?perPage=20&search=du+pont&types=donor&types=member&page=3");
  });

  it("supports a custom page param so sibling paginators are left alone", () => {
    const href = lastPageHref(
      "/settings/members",
      { mPage: "7", iPage: "2" },
      { page: 7, total: 21, totalPages: 2 },
      "mPage",
    );
    expect(href).toBe("/settings/members?iPage=2&mPage=2");
  });
});
