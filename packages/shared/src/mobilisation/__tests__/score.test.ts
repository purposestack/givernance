import { describe, expect, it } from "vitest";
import {
  computeMobilisationScore,
  K_ANONYMITY_THRESHOLD,
  MOBILISATION_WEIGHTS,
  type MobilisationInput,
} from "../score.js";

/**
 * Synthetic inputs exercising one tenant per grade band. The numbers
 * are picked so a future re-weight (the "re-evaluation hook" in
 * `docs/31-tenant-mobilization-score.md` § 7) will mechanically need
 * to update this table — that's the canary we want.
 */
function aPlusTenant(): MobilisationInput {
  return {
    uniqueDonorCount: 200,
    activationRate: 1, // 100 pts
    recurringRevenueRatio: 1, // 100 pts
    volumeBaseEur: 1_000_000, // 100 pts (capped)
    growthRate: 1, // 100 pts
    channelDiversity: 1, // 100 pts
  };
}

function bTenant(): MobilisationInput {
  return {
    uniqueDonorCount: 80,
    activationRate: 0.6, // 60
    recurringRevenueRatio: 0.6, // 60
    volumeBaseEur: 1_000, // 60
    growthRate: 0.2, // 60
    channelDiversity: 0.6, // 60
  };
}

function dTenant(): MobilisationInput {
  return {
    uniqueDonorCount: 10,
    activationRate: 0.1, // 10
    recurringRevenueRatio: 0.1, // 10
    volumeBaseEur: 1, // 0
    growthRate: -0.8, // 10
    channelDiversity: 0.1, // 10
  };
}

describe("computeMobilisationScore — weights + grade bands", () => {
  it("weights sum to 100", () => {
    const total =
      MOBILISATION_WEIGHTS.activation +
      MOBILISATION_WEIGHTS.recurrence +
      MOBILISATION_WEIGHTS.scale +
      MOBILISATION_WEIGHTS.growth +
      MOBILISATION_WEIGHTS.diversity;
    expect(total).toBe(100);
  });

  it("an all-perfect tenant lands in A+", () => {
    const result = computeMobilisationScore(aPlusTenant());
    expect(result.isAnonymised).toBe(false);
    expect(result.grade).toBe("A+");
    expect(result.score).toBe(100);
  });

  it("a mid-range tenant lands in B (≥60, <75)", () => {
    const result = computeMobilisationScore(bTenant());
    expect(result.grade).toBe("B");
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.score).toBeLessThan(75);
  });

  it("a struggling tenant lands in D (<40)", () => {
    const result = computeMobilisationScore(dTenant());
    expect(result.grade).toBe("D");
    expect(result.score).toBeLessThan(40);
  });

  it("A band: 75 ≤ score < 90", () => {
    const result = computeMobilisationScore({
      uniqueDonorCount: 100,
      activationRate: 0.8, // 80
      recurringRevenueRatio: 0.8, // 80
      volumeBaseEur: 10_000, // 80
      growthRate: 0.5, // 75
      channelDiversity: 0.8, // 80
    });
    expect(result.grade).toBe("A");
    expect(result.score).toBeGreaterThanOrEqual(75);
    expect(result.score).toBeLessThan(90);
  });

  it("C band: 40 ≤ score < 60", () => {
    const result = computeMobilisationScore({
      uniqueDonorCount: 30,
      activationRate: 0.45,
      recurringRevenueRatio: 0.45,
      volumeBaseEur: 100,
      growthRate: -0.1,
      channelDiversity: 0.45,
    });
    expect(result.grade).toBe("C");
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.score).toBeLessThan(60);
  });
});

describe("computeMobilisationScore — k-anonymity", () => {
  it("tenant with 4 donors is anonymised (default threshold = 5)", () => {
    const input = aPlusTenant();
    input.uniqueDonorCount = 4;
    const result = computeMobilisationScore(input);
    expect(result.isAnonymised).toBe(true);
    expect(result.grade).toBeNull();
    expect(result.score).toBeNull();
    // Components are still computed for debugging / DPO surfaces.
    expect(result.components.activation).toBe(100);
  });

  it("tenant exactly at the threshold (5 donors) is NOT anonymised", () => {
    const input = aPlusTenant();
    input.uniqueDonorCount = K_ANONYMITY_THRESHOLD;
    const result = computeMobilisationScore(input);
    expect(result.isAnonymised).toBe(false);
    expect(result.grade).toBe("A+");
  });

  it("threshold is overridable via opts", () => {
    const result = computeMobilisationScore(
      { ...aPlusTenant(), uniqueDonorCount: 2 },
      {
        kAnonymityThreshold: 2,
      },
    );
    expect(result.isAnonymised).toBe(false);
  });
});

describe("computeMobilisationScore — component clamping", () => {
  it("activationRate > 1 is clamped to 100 pts before weighting", () => {
    const result = computeMobilisationScore({
      uniqueDonorCount: 100,
      activationRate: 5, // intentionally out of band
      recurringRevenueRatio: 0,
      volumeBaseEur: 0,
      growthRate: -1,
      channelDiversity: 0,
    });
    expect(result.components.activation).toBe(100);
    // 100*25 + 0 + 0 + 0 + 0 = 2500 / 100 = 25
    expect(result.score).toBe(25);
  });

  it("activationRate < 0 is clamped to 0", () => {
    const result = computeMobilisationScore({
      uniqueDonorCount: 100,
      activationRate: -0.5,
      recurringRevenueRatio: 0,
      volumeBaseEur: 0,
      growthRate: 0,
      channelDiversity: 0,
    });
    expect(result.components.activation).toBe(0);
  });

  it("NaN input degrades gracefully (clamps to component min)", () => {
    const result = computeMobilisationScore({
      uniqueDonorCount: 100,
      activationRate: Number.NaN,
      recurringRevenueRatio: 0,
      volumeBaseEur: 0,
      growthRate: 0,
      channelDiversity: 0,
    });
    expect(result.components.activation).toBe(0);
  });
});

describe("computeMobilisationScore — Échelle (log scale)", () => {
  // 20 pts per order of magnitude, capped at 100.
  it("€1 → 0 pts (log10 == 0)", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 1,
      growthRate: -1,
      channelDiversity: 0,
    });
    expect(r.components.scale).toBe(0);
  });

  it("€1 000 → 60 pts", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 1_000,
      growthRate: -1,
      channelDiversity: 0,
    });
    expect(r.components.scale).toBe(60);
  });

  it("€100 000 → 100 pts (cap)", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 100_000,
      growthRate: -1,
      channelDiversity: 0,
    });
    expect(r.components.scale).toBe(100);
  });

  it("€10M is clamped at 100 (no overflow past cap)", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 10_000_000,
      growthRate: -1,
      channelDiversity: 0,
    });
    expect(r.components.scale).toBe(100);
  });

  it("zero / negative revenue floors at 0 (safe log handling)", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 0,
      growthRate: -1,
      channelDiversity: 0,
    });
    expect(r.components.scale).toBe(0);
  });
});

describe("computeMobilisationScore — Croissance cap", () => {
  it("+100% → 100 pts", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 0,
      growthRate: 1,
      channelDiversity: 0,
    });
    expect(r.components.growth).toBe(100);
  });

  it("+500% is capped at 100", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 0,
      growthRate: 5,
      channelDiversity: 0,
    });
    expect(r.components.growth).toBe(100);
  });

  it("0% → 50 pts (neutral midpoint)", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 0,
      growthRate: 0,
      channelDiversity: 0,
    });
    expect(r.components.growth).toBe(50);
  });

  it("-100% → 0 pts", () => {
    const r = computeMobilisationScore({
      uniqueDonorCount: 10,
      activationRate: 0,
      recurringRevenueRatio: 0,
      volumeBaseEur: 0,
      growthRate: -1,
      channelDiversity: 0,
    });
    expect(r.components.growth).toBe(0);
  });
});
