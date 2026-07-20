import type { CustomFieldDefinition } from "@givernance/shared/custom-fields";
import { describe, expect, it } from "vitest";
import type { ApiClient } from "@/lib/api";
import {
  customFieldToFilterField,
  fetchCustomFilterFields,
  mergeFilterCatalog,
} from "./filter-catalog";
import { filterFields } from "./filter-presets";

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

function stubClient(payload: unknown): ApiClient {
  return {
    get: async () => payload,
  } as unknown as ApiClient;
}

describe("customFieldToFilterField", () => {
  it("maps a picklist definition with active options and presence operators", () => {
    const field = customFieldToFilterField(
      def({
        key: "segment",
        label: "Segment donateur",
        type: "picklist",
        options: [
          { id: "opt_b", label: "B", active: true, sortOrder: 1 },
          { id: "opt_a", label: "A", active: true, sortOrder: 0 },
          { id: "opt_dead", label: "Dead", active: false, sortOrder: 2 },
        ],
      }),
    );
    expect(field).toMatchObject({
      name: "custom.segment",
      label: "Segment donateur",
      labelKind: "literal",
      type: "select",
      category: "custom",
    });
    expect(field?.operators).toEqual(["eq", "neq", "in", "isNull", "isNotNull"]);
    expect(field?.options).toEqual([
      { value: "opt_a", label: "A" },
      { value: "opt_b", label: "B" },
    ]);
  });

  it("returns null for non-filterable definitions", () => {
    expect(customFieldToFilterField(def({ key: "x", filterable: false }))).toBeNull();
  });

  it("maps currency to a number input", () => {
    const field = customFieldToFilterField(def({ key: "grant", type: "currency" }));
    expect(field?.type).toBe("number");
    expect(field?.operators).toContain("between");
  });
});

describe("mergeFilterCatalog — the compatibility contract", () => {
  it("keeps every core field byte-identical, in order, with custom appended", () => {
    const custom = [customFieldToFilterField(def({ key: "segment" }))].filter(
      (f): f is NonNullable<typeof f> => f !== null,
    );
    const merged = mergeFilterCatalog(filterFields, custom);
    expect(merged.slice(0, filterFields.length)).toEqual(filterFields);
    expect(merged.at(-1)?.name).toBe("custom.segment");
  });

  it("never lets a custom entry shadow a core field", () => {
    const impostor = {
      ...(customFieldToFilterField(def({ key: "x" })) as NonNullable<
        ReturnType<typeof customFieldToFilterField>
      >),
      name: "constituent.email",
    };
    const merged = mergeFilterCatalog(filterFields, [impostor]);
    expect(merged.filter((f) => f.name === "constituent.email")).toHaveLength(1);
    expect(merged.find((f) => f.name === "constituent.email")?.labelKind).toBeUndefined();
  });
});

describe("fetchCustomFilterFields", () => {
  it("extracts well-formed custom entries and drops core/malformed ones", async () => {
    const payload = {
      data: {
        fields: [
          // Core entry — must be ignored (static catalog owns core rendering).
          { name: "constituent.email", type: "string", operators: ["eq"] },
          // Enriched custom entry — `uiType` is the RAW definition type,
          // exactly what serializeCatalogField sends (`uiType: field.customType`).
          {
            name: "custom.segment",
            label: "Segment donateur",
            labelKind: "literal",
            category: "custom",
            type: "string",
            uiType: "picklist",
            operators: ["eq", "neq", "isNull", "isNotNull", "bogus"],
            options: [
              { id: "opt_a", label: "A", active: true },
              { id: "opt_dead", label: "Dead", active: false },
            ],
          },
          // Malformed custom entry — no label.
          { name: "custom.broken", category: "custom", type: "string", operators: ["eq"] },
        ],
      },
    };
    const fields = await fetchCustomFilterFields(stubClient(payload));
    expect(fields).toHaveLength(1);
    expect(fields?.[0]).toMatchObject({
      name: "custom.segment",
      label: "Segment donateur",
      labelKind: "literal",
      category: "custom",
      type: "select",
    });
    expect(fields?.[0]?.operators).toEqual(["eq", "neq", "isNull", "isNotNull"]);
    expect(fields?.[0]?.options).toEqual([{ value: "opt_a", label: "A" }]);
  });

  it("translates every server uiType (raw definition type) to its FE input type", async () => {
    const entry = (key: string, uiType: string, dslType: string) => ({
      name: `custom.${key}`,
      label: key,
      category: "custom",
      type: dslType,
      uiType,
      operators: ["isNull"],
    });
    const fields = await fetchCustomFilterFields(
      stubClient({
        data: {
          fields: [
            entry("mp", "multi_picklist", "array"),
            entry("cur", "currency", "number"),
            entry("lt", "long_text", "string"),
            entry("txt", "text", "string"),
          ],
        },
      }),
    );
    expect(fields?.map((f) => [f.name, f.type])).toEqual([
      ["custom.mp", "multiselect"],
      ["custom.cur", "number"],
      ["custom.lt", "text"],
      ["custom.txt", "text"],
    ]);
  });

  it("returns null when the payload has no custom entries (not yet enriched)", async () => {
    const fields = await fetchCustomFilterFields(
      stubClient({ data: { fields: [{ name: "constituent.email", operators: ["eq"] }] } }),
    );
    expect(fields).toBeNull();
  });

  it("returns null on fetch failure (fallback-to-static)", async () => {
    const failing = {
      get: async () => {
        throw new Error("network");
      },
    } as unknown as ApiClient;
    expect(await fetchCustomFilterFields(failing)).toBeNull();
  });
});
