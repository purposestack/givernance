import { describe, expect, it } from "vitest";

import { formatMonthName, formatMonthYear } from "./format";

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

describe("formatMonthName", () => {
  it("renders a YYYY-MM period as just the capitalized localized month name", () => {
    expect(formatMonthName("2026-05", "fr")).toBe("Mai");
    expect(formatMonthName("2026-01", "fr")).toBe("Janvier");
    expect(formatMonthName("2026-12", "fr")).toBe("Décembre");
  });

  it("translates the month name to the active locale", () => {
    expect(formatMonthName("2026-05", "en")).toBe("May");
    expect(formatMonthName("2026-03", "en")).toBe("March");
  });

  it("is independent of the year (year-grouped lists carry the year in the heading)", () => {
    expect(formatMonthName("2024-07", "fr")).toBe(formatMonthName("2030-07", "fr"));
  });

  it("returns the input unchanged when it is not a well-formed YYYY-MM string", () => {
    expect(formatMonthName("2026", "fr")).toBe("2026");
    expect(formatMonthName("2026-13", "fr")).toBe("2026-13");
    expect(formatMonthName("nope", "fr")).toBe("nope");
  });
});
