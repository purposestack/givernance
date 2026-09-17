import { describe, expect, it } from "vitest";

import { type KnownPaymentMethod, paymentMethodLabel } from "./payment-method";

const t = (key: KnownPaymentMethod) => `label:${key}`;

describe("paymentMethodLabel", () => {
  it("translates known values, including the non-form ones (stripe, check)", () => {
    expect(paymentMethodLabel(t, "wire")).toBe("label:wire");
    expect(paymentMethodLabel(t, "stripe")).toBe("label:stripe");
    expect(paymentMethodLabel(t, "check")).toBe("label:check");
  });

  it("passes unknown values through verbatim", () => {
    expect(paymentMethodLabel(t, "crypto")).toBe("crypto");
  });

  it("returns null when nothing is recorded", () => {
    expect(paymentMethodLabel(t, null)).toBeNull();
    expect(paymentMethodLabel(t, "")).toBeNull();
    expect(paymentMethodLabel(t, undefined)).toBeNull();
  });
});
