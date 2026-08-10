/**
 * Unit tests for the balance-delta decision logic (B2, ADR-032 §2.10).
 *
 * The bug these lock down: the processor used to apply a blind pending→cleared
 * delta for EVERY status_changed, and a blind −cleared for EVERY refund —
 * corrupting org_currency_balances on transitions like pending→failed or a
 * refund of a still-pending donation. The delta must follow the ACTUAL
 * transition, and no-op (null) when the transition data is missing.
 */

import { describe, expect, it } from "vitest";
import { computeBalanceDelta } from "./update-org-currency-balance.processor.js";

const AMT = 10_000;

describe("computeBalanceDelta", () => {
  it("created+cleared → +cleared only", () => {
    expect(computeBalanceDelta({ eventType: "donation.created" }, AMT, "cleared")).toEqual({
      clearedDelta: AMT,
      pendingDelta: 0,
    });
  });

  it("created+pending → +pending only", () => {
    expect(computeBalanceDelta({ eventType: "donation.created" }, AMT, "pending")).toEqual({
      clearedDelta: 0,
      pendingDelta: AMT,
    });
  });

  it("created with a non-accounting status → zero delta", () => {
    expect(computeBalanceDelta({ eventType: "donation.created" }, AMT, "failed")).toEqual({
      clearedDelta: 0,
      pendingDelta: 0,
    });
  });

  it("refund of a CLEARED donation → −cleared (not assumed)", () => {
    expect(
      computeBalanceDelta(
        { eventType: "donation.refunded", priorStatus: "cleared" },
        AMT,
        "refunded",
      ),
    ).toEqual({ clearedDelta: -AMT, pendingDelta: 0 });
  });

  it("refund of a PENDING donation → −pending, never −cleared", () => {
    expect(
      computeBalanceDelta(
        { eventType: "donation.refunded", priorStatus: "pending" },
        AMT,
        "refunded",
      ),
    ).toEqual({ clearedDelta: 0, pendingDelta: -AMT });
  });

  it("refund with no priorStatus → null (safe no-op, never guesses −cleared)", () => {
    expect(computeBalanceDelta({ eventType: "donation.refunded" }, AMT, "refunded")).toBeNull();
  });

  it("status_changed pending→cleared → +cleared/−pending", () => {
    expect(
      computeBalanceDelta(
        { eventType: "donation.status_changed", fromStatus: "pending", toStatus: "cleared" },
        AMT,
        "cleared",
      ),
    ).toEqual({ clearedDelta: AMT, pendingDelta: -AMT });
  });

  it("status_changed pending→failed → −pending only (was the corruption bug)", () => {
    expect(
      computeBalanceDelta(
        { eventType: "donation.status_changed", fromStatus: "pending", toStatus: "failed" },
        AMT,
        "failed",
      ),
    ).toEqual({ clearedDelta: 0, pendingDelta: -AMT });
  });

  it("status_changed cleared→refunded → −cleared only", () => {
    expect(
      computeBalanceDelta(
        { eventType: "donation.status_changed", fromStatus: "cleared", toStatus: "refunded" },
        AMT,
        "refunded",
      ),
    ).toEqual({ clearedDelta: -AMT, pendingDelta: 0 });
  });

  it("status_changed with missing from/to → null (safe no-op)", () => {
    expect(
      computeBalanceDelta(
        { eventType: "donation.status_changed", fromStatus: "pending" },
        AMT,
        "cleared",
      ),
    ).toBeNull();
  });
});
