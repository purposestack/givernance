import type { CustomFieldDefinition, CustomFieldValues } from "@givernance/shared/custom-fields";
import { Badge } from "@/components/ui/badge";
import { CustomFieldValue } from "./custom-field-value";

/** Detail rows accept archived definitions riding along (`archivedAt` set). */
export type DetailRowDefinition = CustomFieldDefinition & { archivedAt?: string | null };

export interface CustomFieldDetailRowsProps {
  definitions: readonly DetailRowDefinition[];
  values: CustomFieldValues | null | undefined;
  locale: string;
  booleanLabels?: { yes: string; no: string };
  /**
   * Chrome label for the badge shown next to an archived definition's row
   * (i18n'd by the caller). Archived rows are read-only by nature here —
   * detail rows never edit — and render muted with this badge.
   */
  archivedLabel?: string;
}

/**
 * DetailRow-style `<dl>` group for a set of custom-field values (Epic #539) —
 * the shared shape behind the "Custom fields" groups on the three domain
 * detail pages and the "Donor details" (donorCustom) group on donations.
 * Hook-free so it renders in RSC pages; callers provide their own card
 * chrome and heading. Labels are operator data rendered literally.
 *
 * Archived definitions (from `fetchDetailCustomFieldDefinitions`) render
 * muted with an "archived" badge — values already entered stay visible per
 * the archive contract; callers pre-filter empty archived rows via
 * `visibleDetailCustomFieldDefinitions`.
 */
export function CustomFieldDetailRows({
  definitions,
  values,
  locale,
  booleanLabels,
  archivedLabel,
}: CustomFieldDetailRowsProps) {
  if (definitions.length === 0) return null;
  return (
    <dl className="space-y-3">
      {definitions.map((definition) => {
        const isArchived = Boolean(definition.archivedAt);
        return (
          <div
            key={definition.id}
            className="flex items-baseline gap-3 border-b border-outline-variant/50 pb-2 last:border-b-0"
          >
            <dt
              className={
                isArchived
                  ? "w-40 shrink-0 text-sm font-medium text-on-surface-variant opacity-70"
                  : "w-40 shrink-0 text-sm font-medium text-on-surface-variant"
              }
            >
              {definition.label}
              {isArchived && archivedLabel ? (
                <Badge variant="neutral" className="ml-2 align-middle">
                  {archivedLabel}
                </Badge>
              ) : null}
            </dt>
            <dd
              className={
                isArchived
                  ? "min-w-0 flex-1 text-sm text-on-surface-variant"
                  : "min-w-0 flex-1 text-sm text-on-surface"
              }
            >
              <CustomFieldValue
                definition={definition}
                value={values?.[definition.key]}
                locale={locale}
                booleanLabels={booleanLabels}
              />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
