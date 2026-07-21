/**
 * Donations filter catalog mapping (flag `donations.advanced_filters`).
 *
 * The fixture payloads below mirror the ACTUAL serialized contract of
 * `GET /v1/donations/filter/fields` — `serializeDonationCatalogField` in
 * `packages/api/src/modules/donations/filters/filter.routes.ts` (options as
 * `{id, label, active}`, enum labels repeating the id, entity labels being
 * tenant names, `labelKind`/`optionsKind`/`valueUnit` discriminators) — the
 * PR #550 lesson: test against what the server actually sends, not a
 * hand-idealized shape.
 */

import type { ApiClient } from "@/lib/api";
import {
  fetchDonationFilterFields,
  mapDonationCatalogField,
  mergeDonationFilterCatalog,
  type RawDonationCatalogField,
} from "./donation-filter-catalog";
import { donationFilterFields } from "./donation-filter-fields";

const CAMPAIGN_ID = "3f7a2b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";
const ARCHIVED_CAMPAIGN_ID = "9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b";
const FUND_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/** Byte-for-byte shapes of real catalog entries (BE serializer output). */
const serializedCatalog: RawDonationCatalogField[] = [
  {
    name: "donation.amount",
    type: "number",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
    label: "fields.donation.amount",
    labelKind: "i18n",
    category: "donation",
    nullable: false,
    valueUnit: "cents",
  },
  {
    name: "donation.status",
    type: "string",
    operators: ["eq", "neq", "in"],
    label: "fields.donation.status",
    labelKind: "i18n",
    category: "payment",
    nullable: false,
    // Enum options: the BE repeats the id as the label (FE localizes ids).
    options: [
      { id: "pending", label: "pending", active: true },
      { id: "cleared", label: "cleared", active: true },
      { id: "refunded", label: "refunded", active: true },
      { id: "failed", label: "failed", active: true },
    ],
    optionsKind: "enum",
  },
  {
    name: "donation.campaign",
    type: "string",
    operators: ["eq", "neq", "in", "isNull", "isNotNull"],
    label: "fields.donation.campaign",
    labelKind: "i18n",
    category: "attribution",
    nullable: true,
    // Entity options: per-org tenant data, labels rendered literally.
    options: [
      { id: CAMPAIGN_ID, label: "Christmas Appeal 2026", active: true },
      { id: ARCHIVED_CAMPAIGN_ID, label: "Old Gala", active: false },
    ],
    optionsKind: "entity",
  },
  {
    name: "donation.fund",
    type: "string",
    operators: ["eq", "in", "isNull", "isNotNull"],
    label: "fields.donation.fund",
    labelKind: "i18n",
    category: "attribution",
    nullable: true,
    options: [{ id: FUND_ID, label: "Emergency Relief", active: true }],
    optionsKind: "entity",
  },
];

describe("mergeDonationFilterCatalog", () => {
  it("returns the static catalog unchanged when the fetch failed (null)", () => {
    expect(mergeDonationFilterCatalog(donationFilterFields, null)).toBe(donationFilterFields);
  });

  it("injects active entity options into the matching static fields, literally labelled", () => {
    const merged = mergeDonationFilterCatalog(donationFilterFields, serializedCatalog);

    const campaign = merged.find((f) => f.name === "donation.campaign");
    expect(campaign).toBeDefined();
    expect(campaign?.options).toEqual([{ value: CAMPAIGN_ID, label: "Christmas Appeal 2026" }]);
    expect(campaign?.optionLabelKind).toBe("literal");
    // Curated static shape survives the merge — field label stays an i18n
    // key, operators stay the curated set.
    expect(campaign?.label).toBe("fields.donation.campaign");
    expect(campaign?.labelKind).toBeUndefined();
    expect(campaign?.operators).toEqual(["eq", "neq", "in", "isNull", "isNotNull"]);

    const fund = merged.find((f) => f.name === "donation.fund");
    expect(fund?.options).toEqual([{ value: FUND_ID, label: "Emergency Relief" }]);
    expect(fund?.optionLabelKind).toBe("literal");
  });

  it("keeps the static i18n enum options for enum-optioned fields (no overwrite)", () => {
    const merged = mergeDonationFilterCatalog(donationFilterFields, serializedCatalog);
    const status = merged.find((f) => f.name === "donation.status");
    // The static mirror's option labels are i18n keys, NOT the raw ids the
    // BE serializer repeats.
    expect(status?.options?.map((o) => o.label)).toEqual([
      "options.donation.status.pending",
      "options.donation.status.cleared",
      "options.donation.status.refunded",
      "options.donation.status.failed",
    ]);
    expect(status?.optionLabelKind).toBeUndefined();
  });

  it("does not drop or duplicate static fields", () => {
    const merged = mergeDonationFilterCatalog(donationFilterFields, serializedCatalog);
    expect(merged.map((f) => f.name)).toEqual(donationFilterFields.map((f) => f.name));
  });

  it("appends BE-only fields the static mirror does not know, generically mapped", () => {
    const future: RawDonationCatalogField = {
      name: "donation.giftAidStatus",
      type: "string",
      operators: ["eq", "in"],
      label: "fields.donation.giftAidStatus",
      labelKind: "i18n",
      category: "donation",
      nullable: false,
      options: [
        { id: "claimed", label: "claimed", active: true },
        { id: "excluded", label: "excluded", active: false },
      ],
      optionsKind: "enum",
    };
    const merged = mergeDonationFilterCatalog(donationFilterFields, [...serializedCatalog, future]);
    const appended = merged.find((f) => f.name === "donation.giftAidStatus");
    expect(appended).toBeDefined();
    expect(appended?.type).toBe("select");
    expect(appended?.operators).toEqual(["eq", "in"]);
    // Enum ids are FE-localized under `options.<field>.<id>`; inactive
    // options are dropped.
    expect(appended?.options).toEqual([
      { value: "claimed", label: "options.donation.giftAidStatus.claimed" },
    ]);
    expect(appended?.optionLabelKind).toBe("i18n");
  });
});

describe("mapDonationCatalogField", () => {
  it("maps a plain string field to a text input", () => {
    const mapped = mapDonationCatalogField({
      name: "donation.somethingNew",
      type: "string",
      operators: ["eq", "contains", "isNull", "isNotNull"],
      label: "fields.donation.somethingNew",
      labelKind: "i18n",
      category: "payment",
      nullable: true,
    });
    expect(mapped).toEqual({
      name: "donation.somethingNew",
      label: "fields.donation.somethingNew",
      labelKind: "i18n",
      type: "text",
      category: "payment",
      operators: ["eq", "contains", "isNull", "isNotNull"],
    });
  });

  it("maps date / number / boolean DSL types onto the matching input widgets", () => {
    for (const [dsl, ui] of [
      ["date", "date"],
      ["number", "number"],
      ["boolean", "boolean"],
    ] as const) {
      const mapped = mapDonationCatalogField({
        name: "donation.x",
        type: dsl,
        operators: ["eq"],
        label: "fields.donation.x",
        labelKind: "i18n",
        category: "donation",
        nullable: false,
      });
      expect(mapped?.type).toBe(ui);
    }
  });

  it("preserves entity option labels literally", () => {
    const mapped = mapDonationCatalogField(
      serializedCatalog.find((f) => f.name === "donation.campaign") as RawDonationCatalogField,
    );
    expect(mapped?.options).toEqual([{ value: CAMPAIGN_ID, label: "Christmas Appeal 2026" }]);
    expect(mapped?.optionLabelKind).toBe("literal");
  });

  it("rejects malformed entries", () => {
    // Missing name.
    expect(
      mapDonationCatalogField({
        type: "string",
        operators: ["eq"],
        label: "x",
        category: "donation",
      }),
    ).toBeNull();
    // No recognizable operator.
    expect(
      mapDonationCatalogField({
        name: "donation.bad",
        type: "string",
        operators: ["explode"],
        label: "fields.donation.bad",
        category: "donation",
      }),
    ).toBeNull();
    // Unknown category (would render an untranslatable section header).
    expect(
      mapDonationCatalogField({
        name: "donation.bad",
        type: "string",
        operators: ["eq"],
        label: "fields.donation.bad",
        category: "mystery",
      }),
    ).toBeNull();
    // Unknown DSL type with no options → no widget to render.
    expect(
      mapDonationCatalogField({
        name: "donation.bad",
        type: "geometry",
        operators: ["eq"],
        label: "fields.donation.bad",
        category: "donation",
      }),
    ).toBeNull();
  });
});

describe("custom fields (Epic #539, donation domain)", () => {
  /** Byte-for-byte shapes of the BE serializer's CUSTOM catalog entries
   * (`serializeDonationCatalogField`, `field.source === "custom"` branch):
   * literal operator-authored label, raw definition type as `uiType`,
   * options with the active bit, NO `optionsKind`, `nullable: true`. */
  const customPicklist: RawDonationCatalogField = {
    name: "custom.channel",
    type: "string",
    operators: ["eq", "neq", "in", "isNull", "isNotNull"],
    label: "Canal de collecte",
    labelKind: "literal",
    category: "custom",
    nullable: true,
    uiType: "picklist",
    options: [
      { id: "opt_gala0000", label: "Gala", active: true },
      { id: "opt_online00", label: "En ligne", active: true },
      { id: "opt_legacy00", label: "Ancien canal", active: false },
    ],
  };
  const customMulti: RawDonationCatalogField = {
    name: "custom.themes",
    type: "array",
    operators: ["arrayContains", "arrayOverlaps", "isNull", "isNotNull"],
    label: "Thématiques",
    labelKind: "literal",
    category: "custom",
    nullable: true,
    uiType: "multi_picklist",
    options: [{ id: "opt_env00000", label: "Environnement", active: true }],
  };
  const customCurrency: RawDonationCatalogField = {
    name: "custom.match_amount",
    type: "number",
    operators: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "isNull", "isNotNull"],
    label: "Montant du matching",
    labelKind: "literal",
    category: "custom",
    nullable: true,
    uiType: "currency",
    valueUnit: "cents",
  };

  it("maps a custom picklist: literal label, translated uiType, literal options", () => {
    const mapped = mapDonationCatalogField(customPicklist);
    expect(mapped).toEqual({
      name: "custom.channel",
      label: "Canal de collecte",
      labelKind: "literal",
      // 'picklist' must be translated to the FE 'select' widget — untranslated
      // it would degrade to a free-text input whose typed label can never
      // match the stored `opt_*` ids (PR #550 lesson).
      type: "select",
      category: "custom",
      operators: ["eq", "neq", "in", "isNull", "isNotNull"],
      // Active options only; labels are tenant data rendered literally.
      options: [
        { value: "opt_gala0000", label: "Gala" },
        { value: "opt_online00", label: "En ligne" },
      ],
      optionLabelKind: "literal",
    });
  });

  it("maps multi_picklist → multiselect (not the options-imply-select default)", () => {
    const mapped = mapDonationCatalogField(customMulti);
    expect(mapped?.type).toBe("multiselect");
    expect(mapped?.optionLabelKind).toBe("literal");
  });

  it("maps currency → number and keeps the literal label", () => {
    const mapped = mapDonationCatalogField(customCurrency);
    expect(mapped?.type).toBe("number");
    expect(mapped?.label).toBe("Montant du matching");
    expect(mapped?.labelKind).toBe("literal");
  });

  it("appends custom fields to the merged catalog after the static set", () => {
    const merged = mergeDonationFilterCatalog(donationFilterFields, [
      ...serializedCatalog,
      customPicklist,
      customCurrency,
    ]);
    const names = merged.map((f) => f.name);
    expect(names.slice(0, donationFilterFields.length)).toEqual(
      donationFilterFields.map((f) => f.name),
    );
    expect(names).toContain("custom.channel");
    expect(names).toContain("custom.match_amount");
    const channel = merged.find((f) => f.name === "custom.channel");
    expect(channel?.category).toBe("custom");
    expect(channel?.labelKind).toBe("literal");
  });
});

describe("fetchDonationFilterFields", () => {
  it("unwraps the { data: { fields } } envelope", async () => {
    const client = {
      get: vi.fn().mockResolvedValue({ data: { fields: serializedCatalog } }),
    } as unknown as ApiClient;
    await expect(fetchDonationFilterFields(client)).resolves.toEqual(serializedCatalog);
    expect((client as unknown as { get: ReturnType<typeof vi.fn> }).get).toHaveBeenCalledWith(
      "/v1/donations/filter/fields",
    );
  });

  it("returns null on a non-array payload or a failed request (flag off → 404)", async () => {
    const badPayload = {
      get: vi.fn().mockResolvedValue({ data: { fields: "nope" } }),
    } as unknown as ApiClient;
    await expect(fetchDonationFilterFields(badPayload)).resolves.toBeNull();

    const failing = {
      get: vi.fn().mockRejectedValue(new Error("404")),
    } as unknown as ApiClient;
    await expect(fetchDonationFilterFields(failing)).resolves.toBeNull();
  });
});
