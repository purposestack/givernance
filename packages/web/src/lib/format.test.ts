import { describe, expect, it } from "vitest";

import { formatMonthYear } from "./format";

describe("formatMonthYear", () => {
  it("renders a YYYY-MM period as a capitalized French month + year", () => {
    expect(formatMonthYear("2026-05", "fr")).toBe("Mai 2026");
    expect(formatMonthYear("2026-01", "fr")).toBe("Janvier 2026");
    expect(formatMonthYear("2026-12", "fr")).toBe("Décembre 2026");
  });

  it("translates the month name to the active locale", () => {
    expect(formatMonthYear("2026-05", "en")).toBe("May 2026");
    expect(formatMonthYear("2026-01", "en")).toBe("January 2026");
  });

  it("does not drift across timezone boundaries (constructs midday UTC)", () => {
    // A naive `new Date("2026-03-01")` parses as UTC midnight, which in a
    // negative-offset timezone would render as February — guard against it.
    expect(formatMonthYear("2026-03", "fr")).toBe("Mars 2026");
  });

  it("returns the input unchanged when it is not a well-formed YYYY-MM string", () => {
    expect(formatMonthYear("2026", "fr")).toBe("2026");
    expect(formatMonthYear("2026-13", "fr")).toBe("2026-13");
    expect(formatMonthYear("2026-00", "fr")).toBe("2026-00");
    expect(formatMonthYear("not-a-month", "fr")).toBe("not-a-month");
    expect(formatMonthYear("", "fr")).toBe("");
  });
});
