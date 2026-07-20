import type { CustomFieldDefinition, CustomFieldValues } from "@givernance/shared/custom-fields";
import type { ColumnDef } from "@tanstack/react-table";
import { CustomFieldValue } from "./custom-field-value";

export interface CustomFieldColumnsOptions<TRow> {
  locale: string;
  /**
   * Where the values live on the row — `(row) => row.custom` for a domain's
   * own fields, `(row) => row.donorCustom` for the cross-domain projection.
   * Rendered defensively: an absent blob (older API build, projection off)
   * renders every cell as the empty em-dash.
   */
  getValues: (row: TRow) => CustomFieldValues | null | undefined;
  /** Column-id prefix; keeps `custom_` and `donorCustom_` ids collision-free. */
  idPrefix?: string;
  /** Localised yes/no for boolean cells (`customFields.boolean.*`). */
  booleanLabels?: { yes: string; no: string };
}

/**
 * One flag-gated conditional column per definition (Epic #539), for spreading
 * into the existing column-set `useMemo`s:
 *
 *   ...(customFieldsEnabled ? buildCustomFieldColumns(defs, {...}) : []),
 *
 * Headers are the operator-authored labels rendered literally (never i18n
 * keys). Sorting is disabled: the list endpoints' sort whitelists don't
 * accept `custom.<key>` yet — flip `enableSorting` once the API whitelists
 * them, the column `id` is already the DSL name.
 */
export function buildCustomFieldColumns<TRow>(
  definitions: readonly CustomFieldDefinition[],
  options: CustomFieldColumnsOptions<TRow>,
): ColumnDef<TRow>[] {
  const prefix = options.idPrefix ?? "custom";
  return definitions.map((definition) => ({
    id: `${prefix}_${definition.key}`,
    enableSorting: false,
    header: () => <span>{definition.label}</span>,
    cell: ({ row }: { row: { original: TRow } }) => (
      <CustomFieldValue
        definition={definition}
        value={options.getValues(row.original)?.[definition.key]}
        locale={options.locale}
        booleanLabels={options.booleanLabels}
      />
    ),
  }));
}
