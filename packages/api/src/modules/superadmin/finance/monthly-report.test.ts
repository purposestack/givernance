/**
 * Unit tests — month resolution + validation helpers (issue #443).
 * These are pure functions so we can pin behaviour around the calendar
 * boundaries (Jan/Dec rollover, leap year, platform floor) without
 * booting the API server or a Postgres connection.
 */

import { describe, expect, it } from "vitest";
import {
  MonthValidationError,
  periodForMonth,
  previousMonth,
  validateMonth,
} from "./monthly-report.js";

describe("previousMonth", () => {
  it("mid-month → previous calendar month", () => {
    expect(previousMonth(new Date("2026-05-15T10:00:00Z"))).toBe("2026-04");
  });

  it("on the 1st of January → December of the previous year", () => {
    expect(previousMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2025-12");
  });

  it("on the 1st of March → February (handles non-leap years)", () => {
    expect(previousMonth(new Date("2027-03-01T00:00:00Z"))).toBe("2027-02");
  });
});

describe("validateMonth", () => {
  const now = new Date("2026-05-25T12:00:00Z");

  it("accepts the previous month", () => {
    expect(() => validateMonth("2026-04", now)).not.toThrow();
  });

  it("accepts an older month", () => {
    expect(() => validateMonth("2024-06", now)).not.toThrow();
  });

  it("rejects the current month (not yet complete)", () => {
    expect(() => validateMonth("2026-05", now)).toThrow(MonthValidationError);
  });

  it("rejects a future month", () => {
    expect(() => validateMonth("2027-01", now)).toThrow(MonthValidationError);
  });

  it("rejects months before the 2024-01 platform floor", () => {
    expect(() => validateMonth("2023-12", now)).toThrow(MonthValidationError);
  });

  it("rejects malformed strings", () => {
    expect(() => validateMonth("2026-13", now)).toThrow(MonthValidationError);
    expect(() => validateMonth("not-a-month", now)).toThrow(MonthValidationError);
    expect(() => validateMonth("", now)).toThrow(MonthValidationError);
  });
});

describe("periodForMonth", () => {
  it("April 2026 → from=2026-04-01 UTC, to=2026-05-01 UTC", () => {
    const p = periodForMonth("2026-04");
    expect(p.from.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(p.to.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(p.label).toBe("2026-04");
  });

  it("comparison window mirrors the target month length", () => {
    // April 2026 = 30 days. comparisonTo === from, and comparisonFrom
    // is the same length back — the dashboard delta semantics need an
    // equal-length previous window, not necessarily "the previous
    // calendar month boundary" (which is what the live "today / 7d /
    // 30d / 90d" period helper also enforces).
    const p = periodForMonth("2026-04");
    const months = (p.to.getTime() - p.from.getTime()) / (24 * 60 * 60 * 1000);
    expect(months).toBe(30);
    expect(p.comparisonTo.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect((p.comparisonTo.getTime() - p.comparisonFrom.getTime()) / (24 * 60 * 60 * 1000)).toBe(
      30,
    );
  });

  it("Jan → comparison spills back into the previous year (UTC arithmetic)", () => {
    const p = periodForMonth("2026-01");
    // Comparison-window length equals the target-month length; the
    // boundary that matters for the dashboard delta semantics is that
    // `comparisonTo === from` (no overlap, no gap).
    expect(p.comparisonTo.toISOString()).toBe(p.from.toISOString());
    expect(p.comparisonFrom.getTime()).toBeLessThan(p.from.getTime());
  });
});
