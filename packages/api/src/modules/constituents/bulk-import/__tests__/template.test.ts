/**
 * Import-template generation with custom columns (Epic #539).
 *
 * Pins: off-state template unchanged (no defs ⇒ byte-identical to the
 * pre-#539 body), label headers, `cf_<key>` fallback on core-header
 * collision, formula-injection neutralisation of tenant-authored
 * labels, and the sample-value first row.
 */

import type { CustomFieldDefinition } from "@givernance/shared/custom-fields";
import { describe, expect, it } from "vitest";
import { CANONICAL_HEADERS } from "../parser.js";
import { buildImportTemplateCsv } from "../template.js";

function def(overrides: Partial<CustomFieldDefinition> & { key: string }): CustomFieldDefinition {
  return {
    id: `id-${overrides.key}`,
    domain: "constituent",
    label: overrides.key,
    description: null,
    type: "text",
    options: [],
    sortOrder: 0,
    required: false,
    filterable: true,
    exportable: true,
    showOnRelated: false,
    sensitive: false,
    purposeText: null,
    ...overrides,
  };
}

function headerRowOf(csv: string): string[] {
  // Strip BOM, take the first CRLF line. Header cells in these tests
  // contain no commas, so a plain split is enough.
  const firstLine = csv.replace(/^﻿/, "").split("\r\n")[0] ?? "";
  return firstLine.split(",");
}

describe("buildImportTemplateCsv (Epic #539)", () => {
  it("without defs, emits exactly the canonical headers (off-state unchanged)", () => {
    const csv = buildImportTemplateCsv();
    expect(headerRowOf(csv)).toEqual([...CANONICAL_HEADERS]);
    expect(csv).toBe(buildImportTemplateCsv([]));
  });

  it("appends one column per definition, headered by label", () => {
    const csv = buildImportTemplateCsv([
      def({ key: "donor_segment", label: "Segment donateur" }),
      def({ key: "is_board", label: "Membre du conseil", type: "boolean" }),
    ]);
    expect(headerRowOf(csv)).toEqual([
      ...CANONICAL_HEADERS,
      "Segment donateur",
      "Membre du conseil",
    ]);
  });

  it("falls back to cf_<key> when a label collides with a core header alias", () => {
    const csv = buildImportTemplateCsv([def({ key: "secondary_email", label: "Email" })]);
    expect(headerRowOf(csv)).toEqual([...CANONICAL_HEADERS, "cf_secondary_email"]);
  });

  it("neutralises formula-leading labels (tenant-authored data)", () => {
    const csv = buildImportTemplateCsv([def({ key: "weird", label: "=SUM(A1)" })]);
    const headers = headerRowOf(csv);
    expect(headers[headers.length - 1]).toBe("'=SUM(A1)");
  });

  it("puts a format-revealing sample on the first example row only", () => {
    const csv = buildImportTemplateCsv([
      def({ key: "since", label: "Membre depuis", type: "date" }),
    ]);
    const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
    expect(lines[1]?.endsWith(",2026-03-15")).toBe(true);
    expect(lines[2]?.endsWith(",")).toBe(true);
    // 1 header + 10 example rows, unchanged.
    expect(lines).toHaveLength(11);
  });
});
