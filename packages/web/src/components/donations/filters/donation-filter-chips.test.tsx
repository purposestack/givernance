/**
 * Chip rendering for the donations advanced-filter strip
 * (flag `donations.advanced_filters`).
 *
 * Exercises the shared `FilterChip` + `chipsFromQuery` stack against the
 * DONATIONS catalog + namespace: i18n field labels resolve under
 * `donations.filters.*`, closed-enum option values localize
 * (`cleared` → "Cleared"), and entity option values (campaign names) render
 * the tenant's literal label — never routed through the translator.
 */

import { render, screen } from "@testing-library/react";
import { FilterChip } from "@/components/constituents/filters";
import { chipsFromQuery } from "@/components/constituents/filters/filter-chip-helpers";
import type { FilterQuery } from "@/components/constituents/filters/filter-types";
import { mergeDonationFilterCatalog } from "./donation-filter-catalog";
import { donationFilterFields } from "./donation-filter-fields";

const CAMPAIGN_ID = "3f7a2b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c";

/** Catalog with the per-org campaign entity options AND a donation-domain
 * custom field (Epic #539) injected (BE serializer shapes). */
const catalog = mergeDonationFilterCatalog(donationFilterFields, [
  {
    name: "donation.campaign",
    type: "string",
    operators: ["eq", "neq", "in", "isNull", "isNotNull"],
    label: "fields.donation.campaign",
    labelKind: "i18n",
    category: "attribution",
    nullable: true,
    options: [{ id: CAMPAIGN_ID, label: "Campagne de Noël", active: true }],
    optionsKind: "entity",
  },
  {
    name: "custom.channel",
    type: "string",
    operators: ["eq", "neq", "in", "isNull", "isNotNull"],
    label: "Canal de collecte",
    labelKind: "literal",
    category: "custom",
    nullable: true,
    uiType: "picklist",
    options: [{ id: "opt_gala0000", label: "Gala", active: true }],
  },
]);

function renderChips(query: FilterQuery) {
  const chips = chipsFromQuery(query, (pattern) => pattern, catalog);
  render(
    <>
      {chips.map((chip) => (
        <FilterChip key={chip.id} filter={chip} fields={catalog} namespace="donations.filters" />
      ))}
    </>,
  );
  return chips;
}

describe("donations filter chips", () => {
  it("localizes field label, operator and enum option value", () => {
    renderChips({
      operator: "AND",
      conditions: [{ id: "1", field: "donation.status", operator: "eq", value: "cleared" }],
    });

    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("equals")).toBeInTheDocument();
    expect(screen.getByText("Cleared")).toBeInTheDocument();
  });

  it("renders entity option values (campaign names) literally", () => {
    renderChips({
      operator: "AND",
      conditions: [{ id: "1", field: "donation.campaign", operator: "eq", value: CAMPAIGN_ID }],
    });

    expect(screen.getByText("Campaign")).toBeInTheDocument();
    // Tenant data verbatim — not a translation key, not the raw uuid.
    expect(screen.getByText("Campagne de Noël")).toBeInTheDocument();
    expect(screen.queryByText(CAMPAIGN_ID)).not.toBeInTheDocument();
  });

  it("renders custom-field chips with the literal operator-authored label and option (Epic #539)", () => {
    renderChips({
      operator: "AND",
      conditions: [{ id: "1", field: "custom.channel", operator: "eq", value: "opt_gala0000" }],
    });

    // Field label + option label are tenant data — rendered verbatim, never
    // routed through the translator, never the raw opt_* id.
    expect(screen.getByText("Canal de collecte")).toBeInTheDocument();
    expect(screen.getByText("equals")).toBeInTheDocument();
    expect(screen.getByText("Gala")).toBeInTheDocument();
    expect(screen.queryByText("opt_gala0000")).not.toBeInTheDocument();
  });

  it("renders presence operators without a value and numeric conditions plainly", () => {
    const chips = renderChips({
      operator: "AND",
      conditions: [
        { id: "1", field: "donation.receiptStatus", operator: "isNull", value: null },
        { id: "2", field: "donation.amount", operator: "gte", value: 100 },
      ],
    });

    expect(chips).toHaveLength(2);
    expect(screen.getByText("Receipt status")).toBeInTheDocument();
    expect(screen.getByText("is empty")).toBeInTheDocument();
    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(screen.getByText("greater than or equal")).toBeInTheDocument();
    expect(screen.getByText("100")).toBeInTheDocument();
  });
});
