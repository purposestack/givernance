"use client";

import type { CustomFieldDefinition, CustomFieldValue } from "@givernance/shared/custom-fields";
import { useId } from "react";
import { FormSection } from "@/components/shared/form-section";
import { CustomFieldInput } from "./custom-field-input";

export interface CustomFieldsSectionProps {
  definitions: CustomFieldDefinition[];
  values: Record<string, CustomFieldValue>;
  /** `null` value = cleared key (the parent builds the merge-patch). */
  onChange: (key: string, value: CustomFieldValue | null) => void;
  /** Per-key error messages (server 422 mapping + client required check). */
  errors?: Record<string, string>;
  title: string;
  description?: string;
  disabled?: boolean;
}

/**
 * The "one more `<FormSection>`" appended to each domain form when its
 * custom-fields flag is on and definitions exist (Epic #539). Values live
 * OUTSIDE react-hook-form — the parent owns the map, runs the client-side
 * required check on create, and merges the patch into its API payload. The
 * server registry stays authoritative for validation.
 *
 * Field labels/descriptions are operator data rendered literally (i18n
 * bypassed by contract); `title`/`description` are chrome the parent
 * resolves through its own translator.
 */
export function CustomFieldsSection({
  definitions,
  values,
  onChange,
  errors,
  title,
  description,
  disabled,
}: CustomFieldsSectionProps) {
  const sectionId = useId();
  if (definitions.length === 0) return null;

  return (
    <FormSection title={title} description={description}>
      {definitions.map((definition) => {
        const inputId = `${sectionId}-${definition.key}`;
        const error = errors?.[definition.key];
        return (
          <div key={definition.id} className="space-y-2">
            <label htmlFor={inputId} className="block text-sm font-medium text-on-surface">
              {definition.label}
              {definition.required ? (
                <span aria-hidden="true" className="ml-0.5 text-error">
                  *
                </span>
              ) : null}
            </label>
            {definition.description ? (
              <p className="text-xs text-on-surface-variant">{definition.description}</p>
            ) : null}
            <CustomFieldInput
              id={inputId}
              definition={definition}
              value={values[definition.key]}
              onChange={(next) => onChange(definition.key, next)}
              invalid={Boolean(error)}
              disabled={disabled}
            />
            {error ? (
              <p role="alert" className="text-sm font-medium text-error">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </FormSection>
  );
}
