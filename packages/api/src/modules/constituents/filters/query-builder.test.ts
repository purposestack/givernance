/**
 * Unit coverage for the custom-field JSONB lanes of the query builder
 * (review MAJOR-3 + m4). Compiles the generated SQL with PgDialect — no
 * database needed — to pin two contracts:
 *
 *   - m4: custom-date comparisons bind the raw `YYYY-MM-DD` STRING, never a
 *     JS Date. A Date round-trip serializes in PROCESS-LOCAL time, so west
 *     of UTC the UTC-midnight Date becomes the previous local day and every
 *     custom-date eq/bound is off by one. CI runs in UTC, which is exactly
 *     why the binding (not just the behaviour) must be pinned here.
 *
 *   - MAJOR-3: every cast lane is fenced (`jsonb_typeof` for numeric /
 *     boolean, strict shape regex + `pg_input_is_valid` for date) so stale
 *     old-typed values left behind by an archive-and-recreate type change
 *     compare as NULL instead of 22P02-aborting the whole statement. The
 *     behavioural half (real Postgres, stale blobs, sort + export) lives in
 *     `tests/integration/filters-custom-fields.test.ts`.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  customBooleanExpr,
  customDateExpr,
  customNumericExpr,
  FilterQueryBuilder,
} from "./query-builder.js";
import type { FieldMetadata } from "./types.js";

const ORG_ID = "00000000-0000-0000-0000-0000000000aa";
const dialect = new PgDialect();

const REGISTRY: Record<string, FieldMetadata> = {
  "constituent.createdAt": {
    name: "constituent.createdAt",
    type: "date",
    table: "constituents",
    column: "created_at",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  },
  "donations.lastDate": {
    name: "donations.lastDate",
    type: "date",
    table: "donations",
    column: "donated_at",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    aggregate: "max",
  },
  "custom.last_review": {
    name: "custom.last_review",
    type: "date",
    table: "constituents",
    column: "custom",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
    source: "custom",
    customType: "date",
    jsonKey: "last_review",
    nullable: true,
  },
  "custom.score": {
    name: "custom.score",
    type: "number",
    table: "constituents",
    column: "custom",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
    source: "custom",
    customType: "number",
    jsonKey: "score",
    nullable: true,
  },
};

function compile(condition: { field: string; operator: string; value?: unknown }) {
  const builder = new FilterQueryBuilder(ORG_ID, REGISTRY);
  const where = builder.buildWhereClause({
    operator: "AND",
    // biome-ignore lint/suspicious/noExplicitAny: DSL literals in a test
    conditions: [condition as any],
  });
  expect(where).toBeDefined();
  // biome-ignore lint/style/noNonNullAssertion: asserted above
  return dialect.sqlToQuery(where!);
}

describe("custom-date value binding (review m4)", () => {
  it("binds the raw YYYY-MM-DD string for eq — never a JS Date", () => {
    const { params } = compile({
      field: "custom.last_review",
      operator: "eq",
      value: "2026-01-15",
    });
    expect(params).toContain("2026-01-15");
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it("binds both between bounds as raw day strings", () => {
    const { params } = compile({
      field: "custom.last_review",
      operator: "between",
      value: ["2026-01-01", "2026-01-15"],
    });
    expect(params).toContain("2026-01-01");
    expect(params).toContain("2026-01-15");
    expect(params.some((p) => p instanceof Date)).toBe(false);
  });

  it("binds the raw day string for the bumped upper-bound operators (lte / gt)", () => {
    for (const operator of ["lte", "gt"] as const) {
      const { params } = compile({ field: "custom.last_review", operator, value: "2026-01-15" });
      // ::date granularity makes the core end-of-day bump a no-op — the bare
      // day must survive untouched.
      expect(params).toContain("2026-01-15");
      expect(params.some((p) => p instanceof Date)).toBe(false);
    }
  });
});

describe("core-date bounds are UTC-explicit (issue #582)", () => {
  // The flake: `endOfDay` used to emit `YYYY-MM-DDT23:59:59.999` WITHOUT a
  // timezone suffix, which the `toDate` step parsed in PROCESS-LOCAL time.
  // East of UTC the upper bound then landed before the UTC end of day and
  // rows created late in the UTC day dropped out — reproducible locally
  // between 00h and 02h Europe/Paris, never in CI (TZ=UTC). These tests pin
  // the bound in an extreme UTC+14 zone so CI catches any regression.
  // Runtime TZ changes are honoured on POSIX since Node 13 (not on Windows,
  // where the fixed code still passes because the bound is TZ-independent).
  const withTz = (tz: string, fn: () => void) => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      fn();
    } finally {
      if (prev === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = prev;
      }
    }
  };

  const isoOf = (p: unknown): string | null => {
    const d = p instanceof Date ? p : typeof p === "string" ? new Date(p) : null;
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
  };

  it("binds both between bounds as UTC instants even in a UTC+14 zone", () => {
    withTz("Pacific/Kiritimati", () => {
      const { params } = compile({
        field: "constituent.createdAt",
        operator: "between",
        value: ["2000-01-01", "2026-03-10"],
      });
      const iso = params.map(isoOf);
      expect(iso).toContain("2000-01-01T00:00:00.000Z");
      expect(iso).toContain("2026-03-10T23:59:59.999Z");
    });
  });

  it("bumps lte / gt to the UTC end of day regardless of process TZ", () => {
    for (const operator of ["lte", "gt"] as const) {
      withTz("Pacific/Kiritimati", () => {
        const { params } = compile({
          field: "constituent.createdAt",
          operator,
          value: "2026-03-10",
        });
        expect(params.map(isoOf)).toContain("2026-03-10T23:59:59.999Z");
      });
    }
  });

  it("applies the same UTC bound on the raw-SQL aggregate date lane (last gift)", () => {
    // buildAggregateCondition has its own operator switch with raw `sql`
    // bindings — it reuses normalizeValue today, but nothing else pins that:
    // a refactor forking the aggregate lane would silently resurrect the
    // local-time bound on "last gift between …" (autopilot review of #582).
    withTz("Pacific/Kiritimati", () => {
      const builder = new FilterQueryBuilder(ORG_ID, REGISTRY);
      const condition = builder.buildAggregateCondition("donations.lastDate", "between", [
        "2025-01-01",
        "2025-12-31",
      ]);
      expect(condition).toBeDefined();
      const { params } = dialect.sqlToQuery(condition!);
      const iso = params.map(isoOf);
      expect(iso).toContain("2025-01-01T00:00:00.000Z");
      expect(iso).toContain("2025-12-31T23:59:59.999Z");
    });
  });
});

describe("guarded cast lanes (review MAJOR-3)", () => {
  it("numeric comparisons are fenced by jsonb_typeof", () => {
    const { sql } = compile({ field: "custom.score", operator: "gt", value: 3 });
    expect(sql).toContain("jsonb_typeof");
    expect(sql).toContain("'number'");
    expect(sql).toContain("::numeric");
  });

  it("date comparisons are fenced by the shape regex AND pg_input_is_valid", () => {
    const { sql } = compile({ field: "custom.last_review", operator: "eq", value: "2026-01-15" });
    expect(sql).toContain("pg_input_is_valid");
    expect(sql).toContain("\\d{4}-\\d{2}-\\d{2}");
  });

  it("standalone lane expressions carry their guards (shared with the sort lane)", () => {
    expect(dialect.sqlToQuery(customNumericExpr("score")).sql).toContain("jsonb_typeof");
    expect(dialect.sqlToQuery(customDateExpr("last_review")).sql).toContain("pg_input_is_valid");
    const bool = dialect.sqlToQuery(customBooleanExpr("board_member")).sql;
    expect(bool).toContain("jsonb_typeof");
    expect(bool).toContain("'boolean'");
  });
});
