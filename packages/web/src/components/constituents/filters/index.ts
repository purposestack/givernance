/**
 * Advanced filter components for constituent segmentation.
 *
 * @module constituents/filters
 */

export { FilterBuilder } from "./FilterBuilder";
export { FilterChip } from "./FilterChip";
export { FilterCondition } from "./FilterCondition";
export { FilterPresets } from "./FilterPresets";
export { FilterPreview } from "./FilterPreview";

export {
  customFieldToFilterField,
  fetchCustomFilterFields,
  mergeFilterCatalog,
} from "./filter-catalog";
export { filterFields, filterPresets, getCategoryLabel, getOperatorLabel } from "./filter-presets";

export type {
  FilterCategory,
  FilterChipData,
  FilterCondition as FilterConditionType,
  FilterField,
  FilterFieldType,
  FilterOperator,
  FilterPattern,
  FilterPreset,
  FilterPreviewResponse,
  FilterQuery,
  LogicalOperator,
  MockFilterAPI,
} from "./filter-types";
