/**
 * Custom-field value errors shared by the three domain modules
 * (constituents / donations / campaigns). Services throw
 * `CustomFieldValidationError` when a `custom` merge-patch fails
 * validation against the org's active catalog; routes map it onto the
 * 422 matrix via `customFieldsProblem`.
 */

import type { CustomFieldValueError } from "@givernance/shared/custom-fields";
import { problemDetail } from "./schemas.js";

export class CustomFieldValidationError extends Error {
  constructor(public readonly errors: CustomFieldValueError[]) {
    super("Custom field validation failed");
    this.name = "CustomFieldValidationError";
  }
}

/**
 * RFC 9457 body for a failed custom-value patch — ONE shape across the
 * three domains so the FE maps it uniformly: machine-readable title
 * `custom_field_validation_failed`, error list under
 * `custom_field_errors` (keys + codes only, never the submitted values —
 * custom values are unredactable PII; docs/35 GDPR posture).
 */
export function customFieldsProblem(errors: CustomFieldValueError[]) {
  return problemDetail(422, "custom_field_validation_failed", "Invalid custom field values", {
    custom_field_errors: errors,
  });
}

/**
 * RFC 9457 body for a `custom` payload sent while the domain's
 * custom-fields flag is off. Mirrors the `multi_type_disabled` pattern —
 * the core CRUD route always works, only the custom affordance is gated.
 */
export function customFieldsDisabledProblem(flagKey: string) {
  return problemDetail(
    422,
    "custom_fields_disabled",
    "Custom fields are not enabled for your organisation.",
    { flag_key: flagKey },
  );
}
