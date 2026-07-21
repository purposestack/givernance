/**
 * Customization engine — shared entry point (Epic #539).
 *
 * Importable from every package including web
 * (`@givernance/shared/custom-fields`): keep this directory free of
 * Drizzle and Node-only dependencies. The Drizzle tables live in
 * `schema/customization.ts`, which imports from here — never the
 * reverse.
 */

export {
  CUSTOM_FIELD_JOBS,
  CUSTOM_FIELD_MERGE_UNDO_TTL_DAYS,
  CUSTOM_FIELDS_CACHE_PREFIX,
  CUSTOM_FIELDS_CACHE_TTL_SECONDS,
  CUSTOM_FIELDS_IMPORT_HEADER_PREFIX,
  CUSTOM_FIELDS_IMPORT_TEMPLATE_VERSION,
  CUSTOM_FIELDS_QUEUE,
  type CustomFieldJobName,
  customFieldsCacheKey,
} from "./constants";
export {
  buildCustomHeaderResolver,
  buildCustomPatchFromRow,
  type CustomHeaderResolver,
  type CustomImportCellError,
  type CustomImportCellErrorCode,
  type CustomImportCellResult,
  type CustomImportRowOutcome,
  customImportAlias,
  customTemplateHeader,
  customTemplateSampleValue,
  findDuplicateCustomHeaderKeys,
  normaliseImportHeader,
  parseCustomImportCell,
} from "./import";
export {
  CUSTOM_FIELD_DESCRIPTION_MAX_LENGTH,
  CUSTOM_FIELD_LABEL_MAX_LENGTH,
  CUSTOM_FIELD_LONG_TEXT_MAX_LENGTH,
  CUSTOM_FIELD_OPTION_LABEL_MAX_LENGTH,
  CUSTOM_FIELD_PURPOSE_MAX_LENGTH,
  CUSTOM_FIELD_QUOTA_CEILINGS,
  CUSTOM_FIELD_QUOTA_KEYS,
  CUSTOM_FIELD_QUOTAS,
  CUSTOM_FIELD_TEXT_MAX_LENGTH,
  type CustomFieldQuotaKey,
  type CustomFieldQuotas,
  resolveCustomFieldQuotas,
  SHOW_ON_RELATED_HARD_CAP,
} from "./limits";
export { isReservedKey, RESERVED_KEY_PREFIXES, RESERVED_KEYS } from "./reserved-keys";
export {
  CUSTOM_FIELD_DOMAIN_VALUES,
  CUSTOM_FIELD_KEY_PATTERN,
  CUSTOM_FIELD_OPTION_ID_PATTERN,
  CUSTOM_FIELD_TYPE_VALUES,
  type CustomFieldDefinition,
  type CustomFieldDomain,
  type CustomFieldOption,
  type CustomFieldPatch,
  type CustomFieldType,
  type CustomFieldValue,
  type CustomFieldValues,
  generateOptionId,
} from "./types";
export {
  applyCustomMergePatch,
  buildCustomValidator,
  type CustomFieldValueError,
  type CustomFieldValueErrorCode,
  type CustomPatchResult,
  type CustomValidator,
  type ValidatePatchOptions,
} from "./validator";
