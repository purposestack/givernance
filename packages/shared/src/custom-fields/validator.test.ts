import { describe, expect, it } from "vitest";
import { isReservedKey } from "./reserved-keys";
import type { CustomFieldDefinition } from "./types";
import { generateOptionId } from "./types";
import { applyCustomMergePatch, buildCustomValidator } from "./validator";

function def(
  partial: Partial<CustomFieldDefinition> & Pick<CustomFieldDefinition, "key" | "type">,
) {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    domain: "constituent" as const,
    label: partial.key,
    description: null,
    options: [],
    sortOrder: 0,
    required: false,
    filterable: true,
    exportable: true,
    showOnRelated: false,
    sensitive: false,
    purposeText: null,
    ...partial,
  } satisfies CustomFieldDefinition;
}

const catalog: CustomFieldDefinition[] = [
  def({ key: "board_member", type: "boolean" }),
  def({ key: "note", type: "text" }),
  def({ key: "biography", type: "long_text" }),
  def({ key: "score", type: "number" }),
  def({ key: "pledged", type: "currency" }),
  def({ key: "joined_on", type: "date" }),
  def({
    key: "segment",
    type: "picklist",
    options: [
      { id: "opt_aaaaaaaa", label: "Ami", active: true, sortOrder: 0 },
      { id: "opt_bbbbbbbb", label: "Grand donateur", active: false, sortOrder: 1 },
    ],
  }),
  def({
    key: "interests",
    type: "multi_picklist",
    options: [
      { id: "opt_cccccccc", label: "Climat", active: true, sortOrder: 0 },
      { id: "opt_dddddddd", label: "Santé", active: true, sortOrder: 1 },
    ],
  }),
  def({ key: "referral", type: "text", required: true }),
];

const validator = buildCustomValidator(catalog);

describe("buildCustomValidator", () => {
  it("accepts a valid mixed patch and merges over existing values", () => {
    const result = validator.validatePatch(
      { note: "keep me", score: 1 },
      {
        board_member: true,
        score: 3.5,
        pledged: 2500,
        joined_on: "2026-02-28",
        segment: "opt_aaaaaaaa",
        interests: ["opt_cccccccc", "opt_dddddddd", "opt_cccccccc"],
      },
    );
    expect(result).toEqual({
      ok: true,
      merged: {
        note: "keep me",
        board_member: true,
        score: 3.5,
        pledged: 2500,
        joined_on: "2026-02-28",
        segment: "opt_aaaaaaaa",
        interests: ["opt_cccccccc", "opt_dddddddd"],
      },
    });
  });

  it("clears keys via explicit null, empty string, and empty array", () => {
    const result = validator.validatePatch(
      { note: "x", segment: "opt_aaaaaaaa", interests: ["opt_cccccccc"] },
      { note: "  ", segment: null, interests: [] },
    );
    expect(result).toEqual({ ok: true, merged: {} });
  });

  it("preserves archived-definition values in existing while rejecting writes to them", () => {
    const result = validator.validatePatch({ legacy_field: "kept" }, { note: "hello" });
    expect(result).toEqual({ ok: true, merged: { legacy_field: "kept", note: "hello" } });

    const write = validator.validatePatch({}, { legacy_field: "nope" });
    expect(write.ok).toBe(false);
    if (!write.ok) {
      expect(write.errors).toEqual([expect.objectContaining({ code: "unknown_key" })]);
    }
  });

  it("collects the COMPLETE error list for the 422 matrix", () => {
    const result = validator.validatePatch(
      {},
      {
        unknown: 1,
        note: "x".repeat(2001),
        biography: "y".repeat(10001),
        score: Number.POSITIVE_INFINITY,
        pledged: 12.5,
        joined_on: "2026-02-30",
        segment: "opt_bbbbbbbb",
        interests: ["opt_zzzzzzzz"],
        board_member: "yes",
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = Object.fromEntries(result.errors.map((error) => [error.key, error.code]));
      expect(codes).toEqual({
        unknown: "unknown_key",
        note: "too_long",
        biography: "too_long",
        score: "not_finite",
        pledged: "not_integer",
        joined_on: "invalid_date",
        segment: "inactive_option",
        interests: "unknown_option",
        board_member: "invalid_type",
      });
    }
  });

  it("enforces required on new writes only when asked", () => {
    const create = validator.validatePatch({}, { note: "hi" }, { enforceRequired: true });
    expect(create.ok).toBe(false);
    if (!create.ok) {
      expect(create.errors).toEqual([
        expect.objectContaining({ key: "referral", code: "required_missing" }),
      ]);
    }
    const update = validator.validatePatch({}, { note: "hi" });
    expect(update.ok).toBe(true);
  });
});

describe("applyCustomMergePatch", () => {
  it("applies one-level merge-patch semantics", () => {
    expect(applyCustomMergePatch({ a: 1, b: "x" }, { b: null, c: true })).toEqual({
      a: 1,
      c: true,
    });
  });
});

describe("reserved keys", () => {
  it("rejects core columns, DSL tokens, import aliases, and reserved prefixes", () => {
    for (const key of ["first_name", "amount_cents", "total_amount", "prenom", "cf_x", "custom"]) {
      expect(isReservedKey(key), key).toBe(true);
    }
    expect(isReservedKey("segment_donateur")).toBe(false);
  });
});

describe("generateOptionId", () => {
  it("matches the opt_ pattern", () => {
    expect(generateOptionId()).toMatch(/^opt_[A-Za-z0-9_-]{8}$/);
  });
});
