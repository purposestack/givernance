/**
 * Bulk-import bridge tests (Epic #539): `cf_<key>` header aliasing,
 * label resolution, CSV-cell coercion — including the two hard
 * guarantees: picklist labels resolve case-insensitively to option ids,
 * and unknown values are per-row errors, never auto-created options.
 */

import { describe, expect, it } from "vitest";
import {
  buildCustomHeaderResolver,
  buildCustomPatchFromRow,
  customImportAlias,
  customTemplateHeader,
  customTemplateSampleValue,
  findDuplicateCustomHeaderKeys,
  parseCustomImportCell,
} from "./import";
import type { CustomFieldDefinition, CustomFieldType } from "./types";

function def(overrides: Partial<CustomFieldDefinition> & { key: string }): CustomFieldDefinition {
  return {
    id: `id-${overrides.key}`,
    domain: "constituent",
    label: overrides.key,
    description: null,
    type: "text" as CustomFieldType,
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

const segment = def({
  key: "donor_segment",
  label: "Segment donateur",
  type: "picklist",
  options: [
    { id: "opt_aaaaaaaa", label: "Grand donateur", active: true, sortOrder: 0 },
    { id: "opt_bbbbbbbb", label: "Ami", active: true, sortOrder: 1 },
    { id: "opt_cccccccc", label: "Ancien", active: false, sortOrder: 2 },
  ],
});

const interests = def({
  key: "interests",
  label: "Centres d'intérêt",
  type: "multi_picklist",
  options: [
    { id: "opt_11111111", label: "Culture", active: true, sortOrder: 0 },
    { id: "opt_22222222", label: "Sport, plein air", active: true, sortOrder: 1 },
  ],
});

describe("buildCustomHeaderResolver", () => {
  const resolve = buildCustomHeaderResolver([segment, interests]);

  it("matches the cf_<key> alias case-insensitively", () => {
    expect(resolve("CF_DONOR_SEGMENT")?.key).toBe("donor_segment");
    expect(resolve(" cf_interests ")?.key).toBe("interests");
  });

  it("matches the label with collapsed whitespace, case-insensitively", () => {
    expect(resolve("segment   DONATEUR")?.key).toBe("donor_segment");
  });

  it("returns null for unknown headers and empty strings", () => {
    expect(resolve("firstName")).toBeNull();
    expect(resolve("")).toBeNull();
  });
});

describe("customTemplateHeader", () => {
  it("emits the label when unambiguous", () => {
    expect(customTemplateHeader(segment, [segment, interests], () => false)).toBe(
      "Segment donateur",
    );
  });

  it("falls back to cf_<key> when the label collides with a core header", () => {
    const shadowing = def({ key: "member_email", label: "Email" });
    expect(
      customTemplateHeader(shadowing, [shadowing], (raw) => raw.toLowerCase() === "email"),
    ).toBe("cf_member_email");
  });

  it("falls back to cf_<key> when two definitions share a label", () => {
    const a = def({ key: "status_a", label: "Statut" });
    const b = def({ key: "status_b", label: "statut" });
    expect(customTemplateHeader(b, [a, b], () => false)).toBe("cf_status_b");
    expect(customTemplateHeader(a, [a, b], () => false)).toBe("Statut");
  });

  it("falls back to cf_<key> when the label sits in the alias namespace", () => {
    // A 'cf_segment' label would resolve (aliases first) into the def whose
    // key is 'segment' — the template must never emit it as a header.
    const segmentDef = def({ key: "segment", label: "Segment" });
    const impostor = def({ key: "other_field", label: "cf_segment" });
    expect(customTemplateHeader(impostor, [segmentDef, impostor], () => false)).toBe(
      "cf_other_field",
    );
  });
});

describe("findDuplicateCustomHeaderKeys (review m12)", () => {
  it("flags a definition addressed by two columns (label + alias both resolved to cf_<key>)", () => {
    expect(
      findDuplicateCustomHeaderKeys(["firstName", "cf_donor_segment", "cf_donor_segment"]),
    ).toEqual(["donor_segment"]);
  });

  it("reports each duplicated definition once, in first-seen order", () => {
    expect(findDuplicateCustomHeaderKeys(["cf_a", "cf_b", "cf_a", "cf_b", "cf_a", "cf_c"])).toEqual(
      ["a", "b"],
    );
  });

  it("ignores core headers, dropped (null) columns, and unique custom columns", () => {
    expect(
      findDuplicateCustomHeaderKeys(["firstName", "firstName", null, "cf_unique", null]),
    ).toEqual([]);
  });
});

describe("parseCustomImportCell", () => {
  it("passes text and date through untouched (validator owns the checks)", () => {
    expect(parseCustomImportCell(def({ key: "note" }), "hello")).toEqual({
      ok: true,
      value: "hello",
    });
    expect(parseCustomImportCell(def({ key: "since", type: "date" }), "2026-03-15")).toEqual({
      ok: true,
      value: "2026-03-15",
    });
  });

  it("parses numbers incl. French decimal comma; rejects non-numeric", () => {
    const n = def({ key: "score", type: "number" });
    expect(parseCustomImportCell(n, "3,5")).toEqual({ ok: true, value: 3.5 });
    expect(parseCustomImportCell(n, "abc")).toMatchObject({
      ok: false,
      error: { code: "INVALID_CUSTOM_NUMBER", field: "cf_score" },
    });
  });

  it("converts currency major units to integer cents, capped at two decimals", () => {
    const c = def({ key: "pledge", type: "currency" });
    expect(parseCustomImportCell(c, "25.50")).toEqual({ ok: true, value: 2550 });
    expect(parseCustomImportCell(c, "1'250,00")).toEqual({ ok: true, value: 125000 });
    expect(parseCustomImportCell(c, "10.999")).toMatchObject({
      ok: false,
      error: { code: "INVALID_CUSTOM_AMOUNT" },
    });
  });

  it("parses boolean variants in EN/FR/DE", () => {
    const b = def({ key: "is_board", type: "boolean" });
    expect(parseCustomImportCell(b, "OUI")).toEqual({ ok: true, value: true });
    expect(parseCustomImportCell(b, "nein")).toEqual({ ok: true, value: false });
    expect(parseCustomImportCell(b, "maybe")).toMatchObject({
      ok: false,
      error: { code: "INVALID_CUSTOM_BOOLEAN" },
    });
  });

  it("resolves picklist labels case-insensitively to option ids", () => {
    expect(parseCustomImportCell(segment, "grand DONATEUR")).toEqual({
      ok: true,
      value: "opt_aaaaaaaa",
    });
    // Raw option id round-trips (re-import of an export).
    expect(parseCustomImportCell(segment, "opt_bbbbbbbb")).toEqual({
      ok: true,
      value: "opt_bbbbbbbb",
    });
  });

  it("rejects unknown and inactive picklist values — never auto-creates options", () => {
    expect(parseCustomImportCell(segment, "Nouveau segment")).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_CUSTOM_OPTION", field: "cf_donor_segment" },
    });
    // Deactivated option label no longer matches.
    expect(parseCustomImportCell(segment, "Ancien")).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_CUSTOM_OPTION" },
    });
  });

  it("splits multi_picklist on ; and | (labels may contain commas), dedupes", () => {
    expect(parseCustomImportCell(interests, "Culture; Sport, plein air | culture")).toEqual({
      ok: true,
      value: ["opt_11111111", "opt_22222222"],
    });
  });
});

describe("buildCustomPatchFromRow", () => {
  it("collects coerced values under definition keys and errors per column", () => {
    const row = {
      firstName: "Alice",
      [customImportAlias("donor_segment")]: "Ami",
      [customImportAlias("interests")]: "Inconnu",
    };
    const { patch, errors } = buildCustomPatchFromRow(row, [segment, interests]);
    expect(patch).toEqual({ donor_segment: "opt_bbbbbbbb" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ field: "cf_interests", code: "UNKNOWN_CUSTOM_OPTION" });
  });

  it("ignores absent and blank cells", () => {
    const { patch, errors } = buildCustomPatchFromRow(
      { [customImportAlias("donor_segment")]: "  " },
      [segment],
    );
    expect(patch).toEqual({});
    expect(errors).toEqual([]);
  });
});

describe("customTemplateSampleValue", () => {
  it("gives format-revealing samples per type", () => {
    expect(customTemplateSampleValue(def({ key: "d", type: "date" }))).toBe("2026-03-15");
    expect(customTemplateSampleValue(def({ key: "b", type: "boolean" }))).toBe("yes");
    expect(customTemplateSampleValue(def({ key: "c", type: "currency" }))).toBe("25.50");
    expect(customTemplateSampleValue(segment)).toBe("Grand donateur");
    expect(customTemplateSampleValue(interests)).toBe("Culture; Sport, plein air");
    expect(customTemplateSampleValue(def({ key: "t" }))).toBe("");
  });
});
