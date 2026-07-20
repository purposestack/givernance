import type { CustomFieldDefinition, CustomFieldValues } from "@givernance/shared/custom-fields";
import { CustomFieldValue } from "./custom-field-value";

export interface CustomFieldDetailRowsProps {
  definitions: readonly CustomFieldDefinition[];
  values: CustomFieldValues | null | undefined;
  locale: string;
  booleanLabels?: { yes: string; no: string };
}

/**
 * DetailRow-style `<dl>` group for a set of custom-field values (Epic #539) —
 * the shared shape behind the "Custom fields" groups on the three domain
 * detail pages and the "Donor details" (donorCustom) group on donations.
 * Hook-free so it renders in RSC pages; callers provide their own card
 * chrome and heading. Labels are operator data rendered literally.
 */
export function CustomFieldDetailRows({
  definitions,
  values,
  locale,
  booleanLabels,
}: CustomFieldDetailRowsProps) {
  if (definitions.length === 0) return null;
  return (
    <dl className="space-y-3">
      {definitions.map((definition) => (
        <div
          key={definition.id}
          className="flex items-baseline gap-3 border-b border-outline-variant/50 pb-2 last:border-b-0"
        >
          <dt className="w-40 shrink-0 text-sm font-medium text-on-surface-variant">
            {definition.label}
          </dt>
          <dd className="min-w-0 flex-1 text-sm text-on-surface">
            <CustomFieldValue
              definition={definition}
              value={values?.[definition.key]}
              locale={locale}
              booleanLabels={booleanLabels}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
