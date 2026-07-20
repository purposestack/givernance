import type { CustomFieldDefinition } from "@givernance/shared/custom-fields";
import { describe, expect, it } from "vitest";
import {
  buildCustomFieldPatch,
  customOptionLabel,
  extractCustomFieldErrors,
  initialCustomValues,
  isEmptyCustomValue,
  missingRequiredCustomKeys,
  projectableDefinitions,
  sanitizeCustomValues,
} from "./definitions";

function def(partial: Partial<CustomFieldDefinition> & { key: string }): CustomFieldDefinition {
  return {
    id: `id-${partial.key}`,
    domain: "constituent",
    label: partial.key,
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
    ...partial,
  };
}

describe("isEmptyCustomValue", () => {
  it("treats null/undefined/blank string/empty array as empty", () => {
    expect(isEmptyCustomValue(null)).toBe(true);
    expect(isEmptyCustomValue(undefined)).toBe(true);
    expect(isEmptyCustomValue("  ")).toBe(true);
    expect(isEmptyCustomValue([])).toBe(true);
  });

  it("keeps false and 0 as real values", () => {
    expect(isEmptyCustomValue(false)).toBe(false);
    expect(isEmptyCustomValue(0)).toBe(false);
  });
});

describe("initialCustomValues", () => {
  it("surfaces only keys with an active definition", () => {
    const defs = [def({ key: "segment" })];
    const values = initialCustomValues(defs, { segment: "opt_a", archived_key: "x" });
    expect(values).toEqual({ segment: "opt_a" });
  });
});

describe("buildCustomFieldPatch", () => {
  const defs = [def({ key: "segment" }), def({ key: "notes" })];

  it("sends explicit null for a cleared previously-set key", () => {
    const patch = buildCustomFieldPatch({ segment: "opt_a" }, {}, defs);
    expect(patch).toEqual({ segment: null });
  });

  it("omits keys that were empty and stay empty", () => {
    const patch = buildCustomFieldPatch({}, {}, defs);
    expect(patch).toBeUndefined();
  });

  it("includes set values", () => {
    const patch = buildCustomFieldPatch({}, { notes: "hello" }, defs);
    expect(patch).toEqual({ notes: "hello" });
  });
});

describe("missingRequiredCustomKeys", () => {
  it("flags required definitions with no value", () => {
    const defs = [def({ key: "a", required: true }), def({ key: "b" })];
    expect(missingRequiredCustomKeys(defs, {})).toEqual(["a"]);
    expect(missingRequiredCustomKeys(defs, { a: "x" })).toEqual([]);
  });
});

describe("projectableDefinitions", () => {
  it("keeps showOnRelated non-sensitive definitions only", () => {
    const defs = [
      def({ key: "public", showOnRelated: true }),
      def({ key: "hidden" }),
      def({ key: "art9", showOnRelated: true, sensitive: true }),
    ];
    expect(projectableDefinitions(defs).map((d) => d.key)).toEqual(["public"]);
  });
});

describe("customOptionLabel", () => {
  it("resolves the operator label and falls back to the raw id", () => {
    const picklist = def({
      key: "segment",
      type: "picklist",
      options: [{ id: "opt_a", label: "Grand donateur", active: true, sortOrder: 0 }],
    });
    expect(customOptionLabel(picklist, "opt_a")).toBe("Grand donateur");
    expect(customOptionLabel(picklist, "opt_missing")).toBe("opt_missing");
  });
});

describe("sanitizeCustomValues", () => {
  it("keeps only validator-shaped values", () => {
    expect(
      sanitizeCustomValues({
        text: "x",
        num: 3,
        bool: true,
        multi: ["a", "b"],
        nested: { evil: 1 },
        mixedArray: ["a", 2],
      }),
    ).toEqual({ text: "x", num: 3, bool: true, multi: ["a", "b"] });
  });

  it("returns undefined for non-objects", () => {
    expect(sanitizeCustomValues(null)).toBeUndefined();
    expect(sanitizeCustomValues([1])).toBeUndefined();
  });
});

describe("extractCustomFieldErrors", () => {
  it("reads dotted custom.<key> entries", () => {
    expect(extractCustomFieldErrors({ "custom.segment": "Unknown option" })).toEqual({
      segment: "Unknown option",
    });
  });

  it("reads nested { custom: { key: msg } } maps", () => {
    expect(extractCustomFieldErrors({ custom: { segment: ["Too long"] } })).toEqual({
      segment: "Too long",
    });
  });

  it("reads { custom: [{ key, message }] } arrays", () => {
    expect(
      extractCustomFieldErrors({ custom: [{ key: "segment", message: "Inactive option" }] }),
    ).toEqual({ segment: "Inactive option" });
  });

  it("ignores unrelated field errors", () => {
    expect(extractCustomFieldErrors({ email: "Invalid" })).toEqual({});
    expect(extractCustomFieldErrors(undefined)).toEqual({});
  });
});
