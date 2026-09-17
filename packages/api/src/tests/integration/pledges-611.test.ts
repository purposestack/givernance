/**
 * Issue #611 item 8 — pledges:
 *   • `createPledge` verifies the constituent belongs to the tenant (404, not
 *     a cross-tenant pointer / 500)
 *   • monthly schedules clamp to the last day of the target month
 */

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildInstallmentDates } from "../../modules/pledges/service.js";
import { createServer } from "../../server.js";
import { authHeader, ensureTestTenants, signToken, signTokenB } from "../helpers/auth.js";

describe("buildInstallmentDates", () => {
  it("clamps a pledge created on Jan 31 to the last day of each month — no skipped months", () => {
    const dates = buildInstallmentDates(new Date("2026-01-31T10:30:00.000Z"), "monthly");

    expect(dates.map((d) => d.toISOString().slice(0, 10))).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      "2026-10-31",
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
    ]);
    // Time of day is preserved, in UTC.
    expect(dates[0]?.toISOString()).toBe("2026-02-28T10:30:00.000Z");
  });

  it("uses Feb 29 in a leap year", () => {
    const dates = buildInstallmentDates(new Date("2028-01-31T00:00:00.000Z"), "monthly");
    expect(dates[0]?.toISOString().slice(0, 10)).toBe("2028-02-29");
  });

  it("leaves mid-month schedules untouched and rolls over the year", () => {
    const dates = buildInstallmentDates(new Date("2026-11-15T00:00:00.000Z"), "monthly");
    expect(dates).toHaveLength(12);
    expect(dates[0]?.toISOString().slice(0, 10)).toBe("2026-12-15");
    expect(dates[1]?.toISOString().slice(0, 10)).toBe("2027-01-15");
    expect(dates[11]?.toISOString().slice(0, 10)).toBe("2027-11-15");
  });

  it("yearly: one installment a year out, Feb 29 clamps to Feb 28", () => {
    expect(
      buildInstallmentDates(new Date("2026-06-10T00:00:00.000Z"), "yearly").map((d) =>
        d.toISOString().slice(0, 10),
      ),
    ).toEqual(["2027-06-10"]);
    expect(
      buildInstallmentDates(new Date("2028-02-29T00:00:00.000Z"), "yearly").map((d) =>
        d.toISOString().slice(0, 10),
      ),
    ).toEqual(["2029-02-28"]);
  });
});

describe("POST /v1/pledges constituent ownership", () => {
  let app: FastifyInstance;
  let tokenA: string;
  let constituentIdA: string;
  let constituentIdB: string;

  beforeAll(async () => {
    app = await createServer();
    await app.ready();
    await ensureTestTenants();
    tokenA = signToken(app);

    const resA = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "Pledge", lastName: "OwnerA", type: "donor" },
    });
    constituentIdA = resA.json<{ data: { id: string } }>().data.id;

    const resB = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(signTokenB(app)),
      payload: { firstName: "Pledge", lastName: "OwnerB", type: "donor" },
    });
    constituentIdB = resB.json<{ data: { id: string } }>().data.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a pledge for the tenant's own constituent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: authHeader(tokenA),
      payload: { constituentId: constituentIdA, amountCents: 2000, frequency: "monthly" },
    });
    expect(res.statusCode).toBe(201);
  });

  it("returns 404 for another tenant's constituent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: authHeader(tokenA),
      payload: { constituentId: constituentIdB, amountCents: 2000, frequency: "monthly" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 (not 500) for an unknown constituent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: authHeader(tokenA),
      payload: {
        constituentId: "00000000-0000-0000-0000-00000000dead",
        amountCents: 2000,
        frequency: "yearly",
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a soft-deleted constituent", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/constituents?force=true",
      headers: authHeader(tokenA),
      payload: { firstName: "Pledge", lastName: "Deleted", type: "donor" },
    });
    const deletedId = created.json<{ data: { id: string } }>().data.id;
    const del = await app.inject({
      method: "DELETE",
      url: `/v1/constituents/${deletedId}`,
      headers: authHeader(tokenA),
    });
    expect(del.statusCode).toBeLessThan(300);

    const res = await app.inject({
      method: "POST",
      url: "/v1/pledges",
      headers: authHeader(tokenA),
      payload: { constituentId: deletedId, amountCents: 2000, frequency: "monthly" },
    });
    expect(res.statusCode).toBe(404);
  });
});
