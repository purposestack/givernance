/**
 * Pure helpers for rendering an applied `FilterQuery` as a chip strip.
 *
 * Extracted from `campaign-members-card.tsx` (Epic #421) so the constituents
 * LIST page (Epic #418 follow-up — advanced filters as a browse/segment tool)
 * can render the exact same "active filters" strip without duplicating the
 * mapping logic. No React in here — both call sites carry their own
 * `useTranslations` hook and pass a resolver in.
 */

import { filterFields } from "./filter-presets";
import {
  type FilterChipData,
  type FilterField,
  type FilterPattern,
  type FilterQuery,
  isFilterCondition,
} from "./filter-types";

/**
 * i18n key suffix for a BE pattern label under
 * `constituents.filters.patterns.*`. Each pattern flag shows up as a
 * removable chip with a clear, localised label so picking "Recurring donors"
 * actually surfaces something operators can see.
 */
export function patternI18nKey(pattern: FilterPattern): string {
  switch (pattern) {
    case "LYBUNT":
      return "lybunt";
    case "SYBUNT":
      return "sybunt";
    case "RECURRING":
      return "recurring";
    case "LAPSED":
      return "lapsed";
    case "MAJOR_DONOR":
      return "majorDonor";
  }
}

/**
 * i18n key (e.g. `fields.donations.lastDate`) for a catalogued field, or the
 * rightmost dotted segment for unknown fields (e.g. a future BE field the FE
 * hasn't catalogued yet) so the chip still reads as something rather than
 * collapsing to empty. `FilterChip` resolves the key to the active locale.
 */
export function chipLabelForField(field: string, catalog: FilterField[] = filterFields): string {
  const known = catalog.find((f) => f.name === field);
  // Custom-field labels are literals; core labels are i18n keys — both
  // shapes flow through `FilterChip`, which renders unregistered keys
  // verbatim (Epic #539 contract).
  if (known) return known.label;
  return field.split(".").pop() || field;
}

/**
 * Build the chip strip from an applied FilterQuery. Two sources:
 *  - Top-level conditions become condition chips (nested groups stay inside
 *    the FilterBuilder dialog — a deeply nested predicate doesn't translate
 *    to a single chip).
 *  - Each `patterns[i]` flag becomes its own pattern chip with a localised
 *    label (resolved by the caller via `patternLabelFor`).
 */
export function chipsFromQuery(
  query: FilterQuery,
  patternLabelFor: (pattern: FilterPattern) => string,
  catalog: FilterField[] = filterFields,
): FilterChipData[] {
  const conditionChips: FilterChipData[] = query.conditions.filter(isFilterCondition).map((c) => ({
    id: c.id,
    kind: "condition" as const,
    label: chipLabelForField(c.field, catalog),
    field: c.field,
    operator: c.operator,
    value: c.value,
  }));

  const patternChips: FilterChipData[] = (query.patterns ?? []).map((pattern) => ({
    // Prefix the chip id so condition ids (numeric strings) can never collide
    // with pattern ids. The strip's remove handler keys on this prefix to
    // decide whether to drop a condition or splice a pattern.
    id: `pattern:${pattern}`,
    kind: "pattern" as const,
    label: patternLabelFor(pattern),
    // Synthetic field/operator/value — pattern chips never need them, but the
    // type insists on the fields existing.
    field: pattern,
    operator: "eq",
    value: pattern,
    pattern,
  }));

  return [...patternChips, ...conditionChips];
}
