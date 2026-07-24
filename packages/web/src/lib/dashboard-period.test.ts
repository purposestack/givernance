import { isoDay, monthBoundsUtc } from "./dashboard-period";

describe("monthBoundsUtc", () => {
  it("returns the UTC calendar month bounds for a mid-month date", () => {
    const { monthStart, monthLastDay } = monthBoundsUtc(new Date("2026-07-24T12:00:00.000Z"));
    expect(isoDay(monthStart)).toBe("2026-07-01");
    expect(isoDay(monthLastDay)).toBe("2026-07-31");
  });

  it("handles the December → January rollover", () => {
    const { monthStart, monthLastDay } = monthBoundsUtc(new Date("2026-12-31T23:59:59.999Z"));
    expect(isoDay(monthStart)).toBe("2026-12-01");
    expect(isoDay(monthLastDay)).toBe("2026-12-31");
  });

  it("handles leap-year February", () => {
    const { monthLastDay } = monthBoundsUtc(new Date("2028-02-10T00:00:00.000Z"));
    expect(isoDay(monthLastDay)).toBe("2028-02-29");
  });

  it("handles non-leap February", () => {
    const { monthLastDay } = monthBoundsUtc(new Date("2026-02-10T00:00:00.000Z"));
    expect(isoDay(monthLastDay)).toBe("2026-02-28");
  });

  it("uses the UTC month, not the server-local one, near a month boundary", () => {
    // 2026-08-01T00:30 UTC is still July 31st in e.g. America/New_York —
    // the bounds must follow UTC regardless of server timezone.
    const { monthStart } = monthBoundsUtc(new Date("2026-08-01T00:30:00.000Z"));
    expect(isoDay(monthStart)).toBe("2026-08-01");
  });
});
